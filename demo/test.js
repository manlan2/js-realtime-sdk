var rt;
var room;
var firstFlag = true;

// 创建聊天实例（支持单页多实例）
rt = AV.realtime({
    // 强将 appId 换为自己的 appId
    appId: '9p6hyhh60av3ukkni3i9z53q1l8yy3cijj6sie3cewft18vm',
    // appId: 'pyon3kvufmleg773ahop2i7zy0tz2rfjx5bh82n7h5jzuwjg',
    clientId: 'LeanCloud111'
    // auth: 'http://signature-example.avosapps.com/sign'
});

// 聊天连接成功
rt.on('open', function() {
    if (firstFlag) {
        firstFlag = false;
        
        // 创建一个聊天室
        room = rt.room({
            // 人员的 id
            members: [
                'LeanCloud02'
            ],
            // 默认的数据，可以放房间名字等
            data: {
                m: 123
            }
        }, function(result) {
            if (!result.avError) {
                console.log('conversation callback');
            }
        });

        // 查询当前房间的相关信息
        rt.query(function(data) {
            console.log('conversation results');
            console.log(data);
        });
    }
});

// 当聊天断开时触发
rt.on('close', function() {
    console.log('close');
});

// 当房间被创建时触发，当然您可以使用回调函数来处理，不一定要监听这个事件
rt.on('create', function(data) {
    // 当前用户加入这个房间
    room.join(function(data) {
        console.log('conversation joined callback');
    });
    // 向这个房间添加新的用户
    room.add([
        'LeanCloud03', 'LeanCloud04'
    ], function(data) {
        console.log('conversation added callback');
        console.log(data);
    });

    // 从这个房间中删除用户
    room.remove('LeanCloud03', function(data) {
        console.log('conversation removed callback');
        console.log(data);
    });

    // 当前用户离开这个房间    
    room.leave(function(data) {
        console.log('conversation leave callback');
    });
    
    // 向这个房间中发送消息
    room.send({
        abc: 123
    }, function(data) {
        console.log('conversation ack callback');
        console.log(data);

        // 查看历史消息
        room.log(function(data) {
            console.log('conversation logs callback');
            console.log(data);
        });

    });

    // 当前房间接收到消息
    room.receive(function(data) {
        console.log('conversation receive callback');        
        console.log(data);
    });

    // 获取当前房间中的成员信息
    room.list(function(data) {
        console.log('conversation list callback');
        console.log(data);
    });

    // 发送多媒体消息
    room.send({
        text: '图片测试',
        // 自定义的属性
        attr: {
            a:123
        },
        url: 'https://leancloud.cn/images/static/press/Logo%20-%20Blue%20Padding.png',
        metaData: {
            name:'logo', 
            format:'png',
            height: 123,
            width: 123,
            size: 888
        }
    }, 'image', function(data) {
        console.log('图片数据发送成功！');
        console.log(data);
    });

    // 取得当前 Room 中的人数
    room.count(function(num) {
        console.log('取得当前的用户数量');
        console.log(num);
    });
});

// 监听所有用户加入的情况
rt.on('join', function(data) {
    console.log('conversation join');
    console.log(data);
});

// 监听所有用户离开的情况
rt.on('left', function(data) {
    console.log('conversation left');
    console.log(data);
});

// 监听所有房间中发送的消息
rt.on('message', function(data) {
    console.log('conversation message');
    console.log(data);
});

// 接收断线或者网络状况不佳的事件
rt.on('reuse', function() {
    console.log('正在重新连接。。。');
});