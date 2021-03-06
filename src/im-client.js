import EventEmitter from 'eventemitter3';
import d from 'debug';
import Conversation from './conversation';
import ConversationQuery from './conversation-query';
import {
  GenericCommand,
  SessionCommand,
  ConvCommand,
  AckCommand,
  JsonObjectMessage,
  ReadCommand,
  ReadTuple,
  CommandType,
  OpType,
} from '../proto/message';
import { ErrorCode } from './error';
import { Expirable, Cache, keyRemap, union, difference, trim, internal, throttle } from './utils';
import { applyDecorators, applyDispatcher } from './plugin';
import runSignatureFactory from './signature-factory-runner';
import { MessageStatus } from './messages/message';
import { version as VERSION } from '../package.json';

const debug = d('LC:IMClient');

export default class IMClient extends EventEmitter {
  /**
   * 无法直接实例化，请使用 {@link Realtime#createIMClient} 创建新的 IMClient。
   *
   * @extends EventEmitter
   * @param  {String} [id] 客户端 id
   * @param  {Object} [options]
   * @param  {Function} [options.signatureFactory] open session 时的签名方法 // TODO need details
   * @param  {Function} [options.conversationSignatureFactory] 对话创建、增减成员操作时的签名方法
   */
  constructor(id, options = {}, connection, props) {
    if (!(id === undefined || typeof id === 'string')) {
      throw new TypeError(`Client id [${id}] is not a String`);
    }
    super();
    Object.assign(this, {
      /**
       * @var id {String} 客户端 id
       * @memberof IMClient#
       */
      id,
      _connection: connection,
      options,
    }, props);

    if (!this._messageParser) {
      throw new Error('IMClient must be initialized with a MessageParser');
    }
    this._conversationCache = new Cache(`client:${this.id}`);
    this._ackMessageBuffer = {};
    internal(this).lastPatchTime = Date.now();
    internal(this)._eventemitter = new EventEmitter();
    [
      'invited',
      'kicked',
      'membersjoined',
      'membersleft',
      'message',
      'unreadmessages',
      'unreadmessagescountupdate',
      'close',
      'conflict',
      'unhandledmessage',
      'reconnect',
      'reconnecterror',
    ].forEach(event => this.on(
      event,
      (...payload) => this._debug(`${event} event emitted. %O`, payload),
    ));
    // onIMClientCreate hook
    applyDecorators(this._plugins.onIMClientCreate, this);
  }

  _debug(...params) {
    debug(...params, `[${this.id}]`);
  }

  /**
   * @override
   * @private
   */
  async _dispatchCommand(command) {
    this._debug(trim(command), 'received');
    switch (command.cmd) {
      case CommandType.conv:
        return this._dispatchConvMessage(command);
      case CommandType.direct:
        return this._dispatchDirectMessage(command);
      case CommandType.session:
        return this._dispatchSessionMessage(command);
      case CommandType.unread:
        return this._dispatchUnreadMessage(command);
      case CommandType.rcp:
        return this._dispatchRcpMessage(command);
      case CommandType.patch:
        return this._dispatchPatchMessage(command);
      default:
        return this.emit('unhandledmessage', command);
    }
  }

  async _dispatchSessionMessage(message) {
    const {
      sessionMessage: {
        code, reason,
      },
    } = message;
    switch (message.op) {
      case OpType.closed: {
        if (code === ErrorCode.SESSION_CONFLICT) {
          /**
           * 用户在其他客户端登录，当前客户端被服务端强行下线。详见文档「单点登录」章节。
           * @event IMClient#conflict
           */
          return this.emit('conflict', {
            reason,
          });
        }
        /**
         * 当前客户端被服务端强行下线
         * @event IMClient#close
         * @param {Object} payload
         * @param {Number} payload.code 错误码
         * @param {String} payload.reason 原因
         */
        return this.emit('close', {
          code, reason,
        });
      }
      default:
        this.emit('unhandledmessage', message);
        throw new Error('Unrecognized session command');
    }
  }

  _dispatchUnreadMessage({
    unreadMessage: {
      convs,
    notifTime,
    },
  }) {
    internal(this).lastUnreadNotifTime = notifTime;
    // ensure all converstions are cached
    return this.getConversations(convs.map(conv => conv.cid)).then(() =>
      // update conversations data
      Promise.all(convs.map(({
          cid,
        unread,
        mid,
        timestamp: ts,
        from,
        data,
        patchTimestamp,
        }) => this.getConversation(cid).then((conversation) => {
          // deleted conversation
          if (!conversation) return null;
          let timestamp;
          if (ts) {
            timestamp = new Date(ts.toNumber());
            conversation.lastMessageAt = timestamp; // eslint-disable-line no-param-reassign
          }
          return (mid ? this._messageParser.parse(data).then((message) => {
            const messageProps = {
              id: mid,
              cid,
              timestamp,
              from,
            };
            if (patchTimestamp) {
              messageProps.updatedAt = new Date(patchTimestamp.toNumber());
            }
            Object.assign(message, messageProps);
            conversation.lastMessage = message; // eslint-disable-line no-param-reassign
          }) : Promise.resolve()).then(() => {
            const countNotUpdated = unread === internal(conversation).unreadMessagesCount;
            if (countNotUpdated) return null; // to be filtered
            // manipulate internal property directly to skip unreadmessagescountupdate event
            internal(conversation).unreadMessagesCount = unread;
            return conversation;
          });
        }),
        // filter conversations without unread count update
      )).then(conversations => conversations.filter(conversation => conversation)),
    ).then((conversations) => {
      if (conversations.length) {
        /**
         * 未读消息数目更新
         * @event IMClient#unreadmessagescountupdate
         * @since 3.4.0
         * @param {Conversation[]} conversations 未读消息数目有更新的对话列表
         */
        this.emit('unreadmessagescountupdate', conversations);
      }
    });
  }

  async _dispatchRcpMessage(message) {
    const {
      rcpMessage,
      rcpMessage: {
        read,
      },
    } = message;
    const conversationId = rcpMessage.cid;
    const messageId = rcpMessage.id;
    const timestamp = new Date(rcpMessage.t.toNumber());
    const conversation = this._conversationCache.get(conversationId);
    // conversation not cached means the client does not send the message
    // during this session
    if (!conversation) return;
    conversation._handleReceipt({ messageId, timestamp, read });
  }

  _dispatchPatchMessage({
      patchMessage: {
        patches,
      },
    }) {
    // ensure all converstions are cached
    return this.getConversations(patches.map(patch => patch.cid)).then(() =>
      Promise.all(patches.map(({
        cid, mid, timestamp, recall, data, patchTimestamp, from,
      }) =>
        this.getConversation(cid).then((conversation) => {
          // deleted conversation
          if (!conversation) return null;
          return this._messageParser.parse(data).then((message) => {
            const patchTime = patchTimestamp.toNumber();
            const messageProps = {
              id: mid,
              cid,
              timestamp: new Date(timestamp.toNumber()),
              updatedAt: new Date(patchTime),
              from,
            };
            Object.assign(message, messageProps);
            message._setStatus(MessageStatus.SENT);
            if (internal(this).lastPatchTime < patchTime) {
              internal(this).lastPatchTime = patchTime;
            }
            // update conversation lastMessage
            if (conversation.lastMessage && conversation.lastMessage.id === mid) {
              conversation.lastMessage = message; // eslint-disable-line no-param-reassign
            }
            if (recall) {
              /**
               * 消息被撤回
               * @event IMClient#messagerecall
               * @param {AVMessage} message 被撤回的消息
               * @param {Conversation} conversation 消息所在的会话
               */
              this.emit('messagerecall', message, conversation);
              /**
               * 消息被撤回
               * @event Conversation#messagerecall
               * @param {AVMessage} message 被撤回的消息
               */
              conversation.emit('messagerecall', message);
            } else {
              /**
               * 消息被修改
               * @event IMClient#messageupdate
               * @param {AVMessage} message 被修改的消息
               * @param {Conversation} conversation 消息所在的会话
               */
              this.emit('messageupdate', message, conversation);
              /**
               * 消息被修改
               * @event Conversation#messageupdate
               * @param {AVMessage} message 被修改的消息
               */
              conversation.emit('messageupdate', message);
            }
          });
        }),
      )),
    );
  }

  async _dispatchConvMessage(message) {
    const {
      convMessage,
      convMessage: {
        initBy, m,
      },
    } = message;
    const conversation = await this.getConversation(convMessage.cid);
    switch (message.op) {
      case OpType.joined: {
        if (!conversation.transient) {
          // eslint-disable-next-line no-param-reassign
          conversation.members = union(conversation.members, [this.id]);
        }
        const payload = {
          invitedBy: initBy,
        };
        /**
         * 当前用户被添加至某个对话
         * @event IMClient#invited
         * @param {Object} payload
         * @param {String} payload.invitedBy 邀请者 id
         * @param {Conversation} conversation
         */
        this.emit('invited', payload, conversation);
        /**
         * 当前用户被添加至当前对话
         * @event Conversation#invited
         * @param {Object} payload
         * @param {String} payload.invitedBy 该移除操作的发起者 id
         */
        conversation.emit('invited', payload);
        return;
      }
      case OpType.left: {
        if (!conversation.transient) {
          // eslint-disable-next-line no-param-reassign
          conversation.members = difference(conversation.members, [this.id]);
        }
        const payload = {
          kickedBy: initBy,
        };
        /**
         * 当前用户被从某个对话中移除
         * @event IMClient#kicked
         * @param {Object} payload
         * @param {String} payload.kickedBy 该移除操作的发起者 id
         * @param {Conversation} conversation
         */
        this.emit('kicked', payload, conversation);
        /**
         * 当前用户被从当前对话中移除
         * @event Conversation#kicked
         * @param {Object} payload
         * @param {String} payload.kickedBy 该移除操作的发起者 id
         */
        conversation.emit('kicked', payload);
        return;
      }
      case OpType.members_joined: {
        if (!conversation.transient) {
          // eslint-disable-next-line no-param-reassign
          conversation.members = union(conversation.members, convMessage.m);
        }
        const payload = {
          invitedBy: initBy,
          members: m,
        };
        /**
         * 有用户被添加至某个对话
         * @event IMClient#membersjoined
         * @param {Object} payload
         * @param {String[]} payload.members 被添加的用户 id 列表
         * @param {String} payload.invitedBy 邀请者 id
         * @param {Conversation} conversation
         */
        this.emit('membersjoined', payload, conversation);
        /**
         * 有成员被添加至当前对话
         * @event Conversation#membersjoined
         * @param {Object} payload
         * @param {String[]} payload.members 被添加的成员 id 列表
         * @param {String} payload.invitedBy 邀请者 id
         */
        conversation.emit('membersjoined', payload);
        return;
      }
      case OpType.members_left: {
        if (!conversation.transient) {
          // eslint-disable-next-line no-param-reassign
          conversation.members = difference(conversation.members, convMessage.m);
        }
        const payload = {
          kickedBy: initBy,
          members: m,
        };
        /**
         * 有成员被从某个对话中移除
         * @event IMClient#membersleft
         * @param {Object} payload
         * @param {String[]} payload.members 被移除的成员 id 列表
         * @param {String} payload.kickedBy 该移除操作的发起者 id
         * @param {Conversation} conversation
         */
        this.emit('membersleft', payload, conversation);
        /**
         * 有成员被从当前对话中移除
         * @event Conversation#membersleft
         * @param {Object} payload
         * @param {String[]} payload.members 被移除的成员 id 列表
         * @param {String} payload.kickedBy 该移除操作的发起者 id
         */
        conversation.emit('membersleft', payload);
        return;
      }
      default:
        this.emit('unhandledmessage', message);
        throw new Error('Unrecognized conversation command');
    }
  }

  _dispatchDirectMessage(originalMessage) {
    const {
      directMessage,
      directMessage: {
        id, cid, fromPeerId, timestamp, transient, patchTimestamp,
      },
    } = originalMessage;
    return Promise.all([
      this.getConversation(directMessage.cid),
      this._messageParser.parse(directMessage.msg),
    ]).then(([conversation, message]) => {
      // deleted conversation
      if (!conversation) return undefined;
      const messageProps = {
        id,
        cid,
        timestamp: new Date(timestamp.toNumber()),
        from: fromPeerId,
      };
      if (patchTimestamp) {
        messageProps.updatedAt = new Date(patchTimestamp.toNumber());
      }
      Object.assign(message, messageProps);
      message._setStatus(MessageStatus.SENT);
      // filter outgoing message sent from another device
      if (message.from !== this.id) {
        if (!(transient || conversation.transient)) {
          this._sendAck(message);
        }
      }
      return this._dispatchParsedMessage(message, conversation);
    });
  }

  _dispatchParsedMessage(message, conversation) {
    // beforeMessageDispatch hook
    return applyDispatcher(this._plugins.beforeMessageDispatch, [message, conversation])
      .then((shouldDispatch) => {
        if (shouldDispatch === false) return;
        conversation.lastMessage = message; // eslint-disable-line no-param-reassign
        conversation.lastMessageAt = message.timestamp; // eslint-disable-line no-param-reassign
        // filter outgoing message sent from another device
        if (message.from !== this.id) {
          conversation.unreadMessagesCount += 1; // eslint-disable-line no-param-reassign
        }
        /**
         * 当前用户收到消息
         * @event IMClient#message
         * @param {Message} message
         * @param {Conversation} conversation 收到消息的对话
         */
        this.emit('message', message, conversation);
        /**
         * 当前对话收到消息
         * @event Conversation#message
         * @param {Message} message
         */
        conversation.emit('message', message);
      });
  }

  _sendAck(message) {
    this._debug('send ack for %O', message);
    const { cid } = message;
    if (!cid) {
      throw new Error('missing cid');
    }
    if (!this._ackMessageBuffer[cid]) {
      this._ackMessageBuffer[cid] = [];
    }
    this._ackMessageBuffer[cid].push(message);
    return this._doSendAck();
  }

  // jsdoc-ignore-start
  @throttle(1000)
  // jsdoc-ignore-end
  _doSendAck() {
    // if not connected, just skip everything
    if (!this._connection.is('connected')) return;
    this._debug('do send ack %O', this._ackMessageBuffer);
    Promise.all(Object.keys(this._ackMessageBuffer).map((cid) => {
      const convAckMessages = this._ackMessageBuffer[cid];
      const timestamps = convAckMessages.map(message => message.timestamp);
      const command = new GenericCommand({
        cmd: 'ack',
        ackMessage: new AckCommand({
          cid,
          fromts: Math.min.apply(null, timestamps),
          tots: Math.max.apply(null, timestamps),
        }),
      });
      delete this._ackMessageBuffer[cid];
      return this._send(command, false).catch((error) => {
        this._debug('send ack failed: %O', error);
        this._ackMessageBuffer[cid] = convAckMessages;
      });
    }));
  }

  _send(cmd, ...args) {
    const command = cmd;
    if (this.id) {
      command.peerId = this.id;
    }
    return this._connection.send(command, ...args);
  }

  _open(appId, tag, deviceId, isReconnect = false) {
    this._debug('open session');
    const {
      lastUnreadNotifTime,
      lastPatchTime,
    } = internal(this);
    return Promise
      .resolve(new GenericCommand({
        cmd: 'session',
        op: 'open',
        appId,
        sessionMessage: new SessionCommand({
          ua: `js/${VERSION}`,
          r: isReconnect,
          lastUnreadNotifTime,
          lastPatchTime,
          configBitmap: 1,
        }),
      }))
      .then((command) => {
        if (isReconnect) {
          // if sessionToken is not expired, skip signature/tag/deviceId
          const sessionToken = internal(this).sessionToken;
          if (sessionToken) {
            const value = sessionToken.value;
            if (value && value !== Expirable.EXPIRED) {
              Object.assign(command.sessionMessage, {
                st: value,
              });
              return command;
            }
          }
        }
        Object.assign(command.sessionMessage, trim({
          tag,
          deviceId,
        }));
        if (this.options.signatureFactory) {
          return runSignatureFactory(this.options.signatureFactory, [this.id])
            .then((signatureResult) => {
              Object.assign(command.sessionMessage, keyRemap({
                signature: 's',
                timestamp: 't',
                nonce: 'n',
              }, signatureResult));
              return command;
            });
        }
        return command;
      })
      .then(this._send.bind(this))
      .then((resCommand) => {
        const {
          peerId,
          sessionMessage: {
            st: token,
            stTtl: tokenTTL,
          },
        } = resCommand;
        if (!peerId) {
          console.warn('Unexpected session opened without peerId.');
          return;
        }
        this.id = peerId;
        if (token) {
          internal(this).sessionToken = new Expirable(token, tokenTTL * 1000);
        }
      }, (error) => {
        if (error.code === ErrorCode.SESSION_TOKEN_EXPIRED) {
          if (internal(this).sessionToken === undefined) {
            // let it fail if sessoinToken not cached but command rejected as token expired
            // to prevent session openning flood
            throw new Error('Unexpected session expiration');
          }
          debug('Session token expired, reopening');
          delete internal(this).sessionToken;
          return this._open(appId, tag, deviceId, isReconnect);
        }
        throw error;
      });
  }

  /**
   * 关闭客户端
   * @return {Promise}
   */
  async close() {
    this._debug('close session');
    const command = new GenericCommand({
      cmd: 'session',
      op: 'close',
    });
    await this._send(command);
    internal(this)._eventemitter.emit('close', {
      code: 0,
    });
    this.emit('close', {
      code: 0,
    });
  }
  /**
   * 获取 client 列表中在线的 client，每次查询最多 20 个 clientId，超出部分会被忽略
   * @param  {String[]} clientIds 要查询的 client ids
   * @return {Primse.<String[]>} 在线的 client ids
   */
  async ping(clientIds) {
    this._debug('ping');
    if (!(clientIds instanceof Array)) {
      throw new TypeError(`clientIds ${clientIds} is not an Array`);
    }
    if (!clientIds.length) {
      return Promise.resolve([]);
    }
    const command = new GenericCommand({
      cmd: 'session',
      op: 'query',
      sessionMessage: new SessionCommand({
        sessionPeerIds: clientIds,
      }),
    });
    const resCommand = await this._send(command);
    return resCommand.sessionMessage.onlineSessionPeerIds;
  }

  /**
   * 获取某个特定的对话
   * @param  {String} id 对话 id，对应 _Conversation 表中的 objectId
   * @param  {Boolean} [noCache=false] 强制不从缓存中获取
   * @return {Promise.<Conversation>} 如果 id 对应的对话不存在则返回 null
   */
  async getConversation(id, noCache = false) {
    if (typeof id !== 'string') {
      throw new TypeError(`${id} is not a String`);
    }
    if (!noCache) {
      const cachedConversation = this._conversationCache.get(id);
      if (cachedConversation) {
        return Promise.resolve(cachedConversation);
      }
    }
    return this
      .getQuery()
      .equalTo('objectId', id)
      .find()
      .then(conversations => conversations[0] || null);
  }

  /**
   * 通过 id 批量获取某个特定的对话
   * @since 3.4.0
   * @param  {String[]} ids 对话 id 列表，对应 _Conversation 表中的 objectId
   * @param  {Boolean} [noCache=false] 强制不从缓存中获取
   * @return {Promise.<Conversation[]>} 如果 id 对应的对话不存在则返回 null
   */
  async getConversations(ids, noCache = false) {
    const remoteConversationIds =
      noCache ? ids : ids.filter(id => this._conversationCache.get(id) === null);
    if (remoteConversationIds.length) {
      await (this.getQuery().containedIn('objectId', remoteConversationIds)).find();
    }
    return ids.map(id => this._conversationCache.get(id));
  }

  /**
   * 构造一个 ConversationQuery 来查询对话
   * @return {ConversationQuery}
   */
  getQuery() {
    return new ConversationQuery(this);
  }

  async _executeQuery(query) {
    const queryJSON = query.toJSON();
    queryJSON.where = new JsonObjectMessage({
      data: JSON.stringify(queryJSON.where),
    });
    const command = new GenericCommand({
      cmd: 'conv',
      op: 'query',
      convMessage: new ConvCommand(queryJSON),
    });
    const resCommand = await this._send(command);
    let conversations;
    try {
      conversations = JSON.parse(resCommand.convMessage.results.data);
    } catch (error) {
      const commandString = JSON.stringify(trim(resCommand));
      throw new Error(`Parse query result failed: ${error.message}. Command: ${commandString}`);
    }
    conversations = await Promise.all(conversations.map(
      this._parseConversationFromRawData.bind(this),
    ));
    return conversations.map((fetchedConversation) => {
      let conversation = this._conversationCache.get(fetchedConversation.id);
      if (!conversation) {
        conversation = fetchedConversation;
        this._debug('no match, set cache');
        this._conversationCache.set(fetchedConversation.id, fetchedConversation);
      } else {
        this._debug('update cached conversation');
        [
          'creator',
          'createdAt',
          'updatedAt',
          'lastMessageAt',
          'lastMessage',
          'mutedMembers',
          'members',
          '_attributes',
          'transient',
          'muted',
        ].forEach((key) => {
          const value = fetchedConversation[key];
          if (value !== undefined) conversation[key] = value;
        });
        conversation._reset();
      }
      return conversation;
    });
  }

  async _parseConversationFromRawData(rawData) {
    const data = keyRemap({
      objectId: 'id',
      lm: 'lastMessageAt',
      msg: 'lastMessage',
      msg_from: 'lastMessageFrom',
      msg_mid: 'lastMessageId',
      msg_timestamp: 'lastMessageTimestamp',
      patch_timestamp: 'lastMessagePatchTimestamp',
      m: 'members',
      tr: 'transient',
      sys: 'system',
      c: 'creator',
      mu: 'mutedMembers',
    }, rawData);
    if (data.lastMessage) {
      const message = await this._messageParser.parse(data.lastMessage);
      data.lastMessage = message;
      message.from = data.lastMessageFrom;
      message.id = data.lastMessageId;
      message.timestamp = new Date(data.lastMessageTimestamp);
      if (data.lastMessagePatchTimestamp) {
        message.updatedAt = new Date(data.lastMessagePatchTimestamp);
      }
      message._setStatus(MessageStatus.SENT);
      delete data.lastMessageFrom;
      delete data.lastMessageId;
      delete data.lastMessageTimestamp;
      delete data.lastMessagePatchTimestamp;
    }
    return new Conversation(data, this);
  }

  /**
   * 创建一个 conversation
   * @param {Object} options 除了下列字段外的其他字段将被视为对话的自定义属性
   * @param {String[]} options.members 对话的初始成员列表，默认包含当前 client
   * @param {String} [options.name] 对话的名字
   * @param {Object} [options.attributes] DEPRECATED: 额外属性，对应 _Conversation 表的 attr 列
   * @param {Boolean} [options.transient=false] 暂态会话
   * @param {Boolean} [options.unique=false] 唯一对话，当其为 true 时，如果当前已经有相同成员的对话存在则返回该对话，否则会创建新的对话
   * @return {Promise.<Conversation>}
   */
  async createConversation(options = {}) {
    const {
      members: m,
      name,
      transient,
      unique,
      ...properties
    } = options;
    if (!(transient || Array.isArray(m))) {
      throw new TypeError(`conversation members ${m} is not an array`);
    }
    let members = new Set(m);
    members.add(this.id);
    members = Array.from(members).sort();
    let attr = properties || {};
    if (name) {
      if (typeof name !== 'string') {
        throw new TypeError(`conversation name ${name} is not a string`);
      }
      attr.name = name;
    }
    attr = new JsonObjectMessage({
      data: JSON.stringify(attr),
    });

    const startCommandJson = {
      m: members,
      attr,
      transient,
      unique,
    };

    const command = new GenericCommand({
      cmd: 'conv',
      op: 'start',
      convMessage: new ConvCommand(startCommandJson),
    });

    if (this.options.conversationSignatureFactory) {
      const params = [null, this.id, members, 'create'];
      const signatureResult = await runSignatureFactory(
        this.options.conversationSignatureFactory,
        params,
      );
      Object.assign(command.convMessage, keyRemap({
        signature: 's',
        timestamp: 't',
        nonce: 'n',
      }, signatureResult));
    }

    const resCommand = await this._send(command);
    const conversation = new Conversation({
      name,
      transient,
      unique,
      id: resCommand.convMessage.cid,
      createdAt: resCommand.convMessage.cdate,
      updatedAt: resCommand.convMessage.cdate,
      lastMessageAt: null,
      creator: this.id,
      members: transient ? [] : members,
      ...properties,
    }, this);
    this._conversationCache.set(conversation.id, conversation);
    return conversation;
  }

  // jsdoc-ignore-start
  @throttle(1000)
  // jsdoc-ignore-end
  _doSendRead() {
    // if not connected, just skip everything
    if (!this._connection.is('connected')) return;
    const buffer = internal(this).readConversationsBuffer;
    const conversations = Array.from(buffer);
    if (!conversations.length) return;
    const ids = conversations.map((conversation) => {
      if (!(conversation instanceof Conversation)) {
        throw new TypeError(`${conversation} is not a Conversation`);
      }
      return conversation.id;
    });
    this._debug(`mark [${ids}] as read`);
    buffer.clear();
    this._sendReadCommand(conversations).catch((error) => {
      this._debug('send read failed: %O', error);
      conversations.forEach(buffer.add.bind(buffer));
    });
  }
  _sendReadCommand(conversations) {
    return this._send(new GenericCommand({
      cmd: 'read',
      readMessage: new ReadCommand({
        convs: conversations.map(conversation => new ReadTuple({
          cid: conversation.id,
          mid: (conversation.lastMessage && conversation.lastMessage.from !== this.id)
            ? conversation.lastMessage.id : undefined,
          timestamp: (conversation.lastMessageAt || new Date()).getTime(),
        })),
      }),
    }), false);
  }
}
