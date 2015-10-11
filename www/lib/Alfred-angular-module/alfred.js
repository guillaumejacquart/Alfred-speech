var alfred = angular.module('alfred', []);

alfred.service('auth', function() {
    var user = window.user;
	var localUser = localStorage.getItem("user");
	if(typeof(user) == 'undefined' && typeof(localUser) != 'undefined'){
		user = JSON.parse(localUser);
	}
	
    return {
        getUser: function() {
            return user;
        },
        setUser: function(newUser) {
            user = newUser;
			localStorage.setItem('user', JSON.stringify(user));
        },
        isConnected: function() {
            return !!user;
        }
    };
});

alfred.factory('websocket', function($q) {
    // We return this object to anything injecting our service
    var Service = {};
    Service.callbacks = [];
    Service.callbacksOpen = [];
    Service.callbacksClose = [];
    var defer = null;
    var ws;

    function createWebsocket(url){
        // Create our websocket object with the address to the websocket
        ws = new WebSocket(url);

        ws.onopen = function(){
            for(var i=0;i<Service.callbacksOpen.length;i++){
                Service.callbacksOpen[i]();
            }
        };

        ws.onmessage = function(message) {
            try{
            var data = JSON.parse(message.data);
            if(data.Command == 'Unauthorized')
            {
                localStorage.removeItem('user');
            }
            listener(data);
            } catch(e){
                listener(message.data);
            }
        };

        ws.onclose = function(){
            console.log("Socket has been closed!");
            var refreshIntervalId = setInterval(
                function () {
                    if (ws.readyState === 1) {
                        console.log("Connection is made");
                        clearInterval(refreshIntervalId);

                    } else if(ws.readyState === 3) {
                        createWebsocket();
                    }

                }, 1000); // wait 1 second for the connection...
                
            for(var i=0;i<Service.callbacksClose.length;i++){
                Service.callbacksClose[i]();
            }
        };
    }

    function sendRequest(request) {
        defer = $q.defer();
        console.log('Sending request', request);
        waitForSocketConnection(ws, function(){
            ws.send(JSON.stringify(request));
        });
        return defer.promise;
    }

    function waitForSocketConnection(socket, callback){
        setTimeout(
            function () {
                if (socket.readyState === 1) {
                    console.log("Connection is made");
                    if(callback != null){
                        callback();
                    }
                    return;

                } else {
                    console.log("wait for connection...")
                    waitForSocketConnection(socket, callback);
                }

            }, 5); // wait 5 milisecond for the connection...
    }

    function listener(data) {
        for(var i=0;i<Service.callbacks.length;i++){
            Service.callbacks[i](data);
        }
    }
	
	Service.init = function(param){
	    createWebsocket('ws://' + param.host + ':' + param.port + '/channel');
	}

    Service.send = function(baseCommand, arguments){
        if(arguments == null)
            arguments = {};
		var localUser = localStorage.getItem("user");
        if (localUser != null) {
            var user = JSON.parse(localUser);
            arguments.token = user.token;
        }

        var request = {
            Command: baseCommand,
            Arguments: arguments
        }
        // Storing in a variable for clarity on what sendRequest returns
        var promise = sendRequest(request);
        return promise;
    }
    
    Service.sendRaw = function(message){
        defer = $q.defer();
        console.log('Sending request', message);
        waitForSocketConnection(ws, function(){
            ws.send(message);
        });
        return defer.promise;
    }

    Service.subscribe = function(callback) {
        Service.callbacks.push(callback);
    }

    Service.unsubscribe = function(callback) {
        var index = Service.callbacks.indexOf(callback);
        if (index > -1) {
            Service.callbacks.splice(index, 1);
        }
    }

    Service.subscribeOpen = function(callback) {
        if(callback){
            Service.callbacksOpen.push(callback);
        }
    }

    Service.subscribeClose = function(callback) {
        if(callback){
            Service.callbacksClose.push(callback);
        }
    }

    return Service;
});


alfred.factory('alfredService', function(websocket, auth, $q, $http) {
    
    var parameters;
    var Service = {};    
    
    Service.init = function(param){
        parameters = param || {};
        parameters.name = parameters.name || 'Alfred-node-client';
        parameters.host = parameters.host || 'localhost';
        parameters.port = parameters.port || 13100;
        parameters.onConnect = parameters.onConnect;
        parameters.onDisconnect = parameters.onDisconnect;  
        
        websocket.subscribeOpen(parameters.onConnect);
        websocket.subscribeClose(parameters.onDisconnect);
        websocket.init(parameters);
    };
    
    Service.subscribe = function (callback) {
        websocket.subscribe(function (data) {
            callback(data);
        });
    };
    
    var events = {};
    Service.on = function (names, handler) {
        names.split(' ').forEach(function (name) {
            if (!events[name]) {
                events[name] = [];
            }
            events[name].push(handler);
        });
        return this;
    };
    
    var trigger = function (name, args) {
        for (var name in events) {
            for (var j in events[name]) {
                var handler = events[name][j];
                handler.call(null, args);
            }
        }
        return this;
    };
    
    websocket.subscribe(function (data) {
        if(data.Event){
            trigger(data.Event, data.Arguments);
        }
    });
    
    Service.User = {
        login: function(login, password){
            websocket.send("User_Login", {
                'login': login,
                'password': password
            });
            
            var deferred = $q.defer();
            var callback = function(data){
                if (data != null
                    && data.Command == 'Authenticated'
                    && data.Arguments != null
                    && typeof(data.Arguments.token) != 'undefined'
                    && typeof(data.Arguments.login) != 'undefined'
                    && data.Arguments.login == login) {
                    auth.setUser(data.Arguments);
                    websocket.unsubscribe(callback);
                    deferred.resolve(data);
                }
                else if(data != null && data.Command == 'AuthenticationFailed'){
                    deferred.reject(data)
                }
            };
                
            websocket.subscribe(callback);
            return deferred.promise;
        }
    };
    
    Service.Lights = {
        lightCommand: function (id, on, bri, hue, sat) {
            var arguments = {
                id: id
            };
            
            if (on != null)
                arguments.on = on;
            if (bri != null)
                arguments.bri = bri;
            if (hue != null)
                arguments.hue = hue;
            if (sat != null)
                arguments.sat = sat;
            
            websocket.send('Device_LightCommand', arguments);
        },
        
        getAll: function () {
            websocket.send("Device_BroadcastLights");
            var deferred = $q.defer();
            
            var callback = function(data){
                if (data != null
                    && data.Arguments != null
                    && typeof(data.Arguments.lights) != 'undefined') {
                    var lights = JSON.parse(data.Arguments.lights);
                    websocket.unsubscribe(callback);
                    deferred.resolve(lights);
                }
            };
              
            websocket.subscribe(callback);
            return deferred.promise;
        },
        
        allumeTout: function () {
            websocket.send("Device_AllumeTout");
        },
        
        eteinsTout: function () {
            websocket.send("Device_EteinsTout");
        },
        
        allume: function (piece) {
            websocket.send("Device_Allume",
			{
                piece: piece
            });
        },
        
        eteins: function (piece) {
            websocket.send("Device_Eteins",
			{
                piece: piece
            });
        },
        
        turnUp: function (piece) {
            websocket.send("Device_TurnUp",
			{
                piece: piece
            });
        },
        
        turnDown: function (piece) {
            websocket.send("Device_TurnDown",
			{
                piece: piece
            });
        }
    };
    
    Service.Sensors = {
        getAll: function () {
            websocket.send("Sensor_BroadcastSensors");
            
            var deferred = $q.defer();
            
            var callback = function(data){
                if(typeof(data.Arguments.sensors) != 'undefined') {
                    var sensors = JSON.parse(data.Arguments.sensors).filter(function(s){
                        return !isNaN(parseFloat(s.Value))
                            && parseFloat(s.Value) != 0
                            && !s.IsActuator;
                    }); 
                    websocket.unsubscribe(callback);
                    deferred.resolve(sensors);
                }
            };
              
            websocket.subscribe(callback);
            
            return deferred.promise;
        },
        
        getHistory: function (id) {
            websocket.send("Sensor_BroadcastSensorHistory", {
                'id': id
            });
            
            var deferred = $q.defer();
            var callback = function(data){
                if(typeof(data.Arguments.history) != 'undefined') {
                    websocket.unsubscribe(callback);
                    deferred.resolve(data.Arguments.history);
                }
            };
            websocket.subscribe(callback);
            return deferred.promise;
        }
    };
    
    Service.TextToSpeech = {
        speak: function (text) {
            websocket.send("Alfred_PlayTempString", {
                'sentence': text
            });
        }
    };
    
    Service.Chat = {
        send: function (text) {
            websocket.send("Chat_Send", {
                'text': text
            });
        }
    };
    
    Service.Scenario = {
        run: function(name){
            websocket.send("Scenario_LaunchScenario", {
                'mode': name
            });
        },
    
        getAll: function(){
            websocket.send("Scenario_BroadcastScenarios");
            
            
            var deferred = $q.defer();
            var callback = function(data){
                if (data != null
                  && data.Arguments != null
                  && typeof(data.Arguments.scenarios) != 'undefined') {
                  var scenarios = JSON.parse(data.Arguments.scenarios);
                  websocket.unsubscribe(callback);
                  deferred.resolve(scenarios);
                }
            };
              
            websocket.subscribe(callback);
            
            return deferred.promise;
        },
    
        save: function(scenario, callback){
            $http.post('http://' + parameters.host + '/scenario/save', scenario);
        }
    };
    
    Service.Torrent = {
        search: function(term, callback){
            $http.get('https://yts.to/api/v2/list_movies.json?query_term=' + term, callback);
        },
    
        download: function(torrentHash, torrentName){
            var tracker = 'udp://open.demonii.com:1337';
            var magnet = 'magnet:?xt=urn:btih:' + torrentHash + '&dn=' + encodeURI(torrentName) + '&tr=' + tracker;
            $http.get('http://' + parameters.host + "/torrent/download?magnet=" + magnet);
        }
    };
    
    Service.People = {
        getAll: function(){
            websocket.send("People_Broadcast");
            
            var deferred = $q.defer();
            var callback = function(data){
                if (data != null
                  && data.Arguments != null
                  && data.Command == 'People_List'
                  && typeof(data.Arguments.people) != 'undefined') {
                  var people = JSON.parse(data.Arguments.people);
                  websocket.unsubscribe(callback);
                  deferred.resolve(people);
                }
            };
              
            websocket.subscribe(callback);
            return deferred.promise;
        }
    };
    
    Service.Player = {
        register: function (name) {
            websocket.send("Player_Register", {
                'name': name
            });
        },
        
        unregister: function (name) {
            websocket.send("Player_Unregister");
        },
        
        sendReadyToPlaySignal : function () {
            websocket.send("Player_ReadyToPlay");
        },
    
        sendPlayPauseSignal : function () {
            websocket.send("MediaManager_PlayPause");
        },
    
        sendNextSongSignal : function () {
            websocket.send("MediaManager_Next");
        },
        
        sendPreviousSongSignal : function () {
            websocket.send("MediaManager_Previous");
        },
    
        sendUpdateStatusSignal : function (status, duration, position, volume) {
            var args = {};
    
            if (status != '')
                args.status = status;
    
            if (!isNaN(duration))
                args.length = ('' + duration).replace('.', ',');
    
            if (!isNaN(position))
                args.position = ('' + position).replace('.', ',');
    
            if (!isNaN(volume))
                args.volume = ('' + volume).replace('.', ',');
    
            websocket.send("MediaManager_UpdateStatus", args);
        }
    };
    
    Service.ping = function(){
        websocket.sendRaw('ping');
    };
    
    return Service;
});