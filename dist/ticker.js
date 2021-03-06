var KiteTicker = function (params) {
  var root = params.root;

  var read_timeout = 5, // seconds
    reconnect_max_delay = 0,
    reconnect_max_tries = 0,
    mSubscribe = "subscribe",
    mUnSubscribe = "unsubscribe",
    mSetMode = "mode",
    // incoming
    mAlert = 10,
    mMessage = 11,
    mLogout = 12,
    mReload = 13,
    mClearCache = 14,
    // public constants
    modeFull = "full", // Full quote including market depth. 164 bytes.
    modeQuote = "quote", // Quote excluding market depth. 52 bytes.
    modeLTP = "ltp";

  this.modeFull = modeFull;
  this.modeQuote = modeQuote;
  this.modeLTP = modeLTP;

  var ws = null,
    triggers = {
      connect: [],
      ticks: [],
      disconnect: [],
      error: [],
      close: [],
      reconnect: [],
      noreconnect: [],
      message: [],
      order_update: [],
    },
    read_timer = null,
    last_read = 0,
    reconnect_timer = null,
    auto_reconnect = false,
    current_reconnection_count = 0,
    last_reconnect_interval = 0;
  (current_ws_url = null),
    (token_modes = {}),
    (defaultReconnectMaxDelay = 60),
    (defaultReconnectMaxRetries = 50),
    (maximumReconnectMaxRetries = 300),
    (minimumReconnectMaxDelay = 5);

  // segment constants
  var NseCM = 1,
    NseFO = 2,
    NseCD = 3,
    BseCM = 4,
    BseFO = 5,
    BseCD = 6,
    McxFO = 7,
    McxSX = 8,
    Indices = 9;

  // Enable auto reconnect by default
  if (!params.reconnect) params.reconnect = true;
  autoReconnect(params.reconnect, params.max_retry, params.max_delay);

  this.autoReconnect = function (t, max_retry, max_delay) {
    autoReconnect(t, max_retry, max_delay);
  };

  this.connect = function () {
    // Skip if its already connected
    if (ws && (ws.readyState == ws.CONNECTING || ws.readyState == ws.OPEN))
      return;

    let ws_auth = {
      api_key: "kitefront",
      user_id: params.user_id,
      enctoken: params.enctoken,
      uid: new Date().getTime().toString(),
      "user-agent": "kite3-web",
      version: "2.9.10",
    };

    var url = root + "?" + encodeQueryData(ws_auth);

    ws = new WebSocket(url);

    ws.binaryType = "arraybuffer";

    ws.onopen = function () {
      // Reset last reconnect interval
      last_reconnect_interval = null;
      // Reset current_reconnection_count attempt
      current_reconnection_count = 0;
      // Store current open connection url to check for auto re-connection.
      if (!current_ws_url) current_ws_url = this.url;
      // Trigger on connect event
      trigger("connect");
      // If there isn't an incoming message in n seconds, assume disconnection.
      clearInterval(read_timer);

      last_read = new Date();
      read_timer = setInterval(function () {
        if ((new Date() - last_read) / 1000 >= read_timeout) {
          // reset current_ws_url incase current connection times out
          // This is determined when last heart beat received time interval
          // exceeds read_timeout value
          current_ws_url = null;
          if (ws) ws.close();
          clearInterval(read_timer);
          triggerDisconnect();
        }
      }, read_timeout * 1000);
    };

    ws.onmessage = function (e) {
      // Binary tick data.
      if (e.data instanceof ArrayBuffer) {
        if (e.data.byteLength > 2) {
          var d = parseBinary(e.data);
          if (d) trigger("ticks", [d]);
        }
      } else {
        parseTextMessage(e.data);
      }

      // Set last read time to check for connection timeout
      last_read = new Date();
    };

    ws.onerror = function (e) {
      trigger("error", [e]);

      // Force close to avoid ghost connections
      if (this && this.readyState == this.OPEN) this.close();
    };

    ws.onclose = function (e) {
      trigger("close", [e]);

      if (current_ws_url && this.url != current_ws_url) return;

      triggerDisconnect(e);
    };
  };

  this.disconnect = function () {
    if (ws && ws.readyState != ws.CLOSING && ws.readyState != ws.CLOSED) {
      ws.close();
    }
  };

  this.connected = function () {
    if (ws && ws.readyState == ws.OPEN) {
      return true;
    } else {
      return false;
    }
  };

  this.on = function (e, callback) {
    if (triggers.hasOwnProperty(e)) {
      triggers[e].push(callback);
    }
  };

  this.subscribe = function (tokens) {
    if (tokens.length > 0) {
      send({ a: mSubscribe, v: tokens });
    }
    return tokens;
  };

  this.unsubscribe = function (tokens) {
    if (tokens.length > 0) {
      send({ a: mUnSubscribe, v: tokens });
    }
    return tokens;
  };

  this.setMode = function (mode, tokens) {
    if (tokens.length > 0) {
      send({ a: mSetMode, v: [mode, tokens] });
    }
    return tokens;
  };

  function autoReconnect(t, max_retry, max_delay) {
    auto_reconnect = t == true;

    // Set default values
    max_retry = max_retry || defaultReconnectMaxRetries;
    max_delay = max_delay || defaultReconnectMaxDelay;

    // Set reconnect constraints
    reconnect_max_tries =
      max_retry >= maximumReconnectMaxRetries
        ? maximumReconnectMaxRetries
        : max_retry;
    reconnect_max_delay =
      max_delay <= minimumReconnectMaxDelay
        ? minimumReconnectMaxDelay
        : max_delay;
  }

  function triggerDisconnect(e) {
    ws = null;
    trigger("disconnect", [e]);
    if (auto_reconnect) attemptReconnection();
  }

  // send a message via the socket
  // automatically encodes json if possible
  function send(message) {
    if (!ws || ws.readyState != ws.OPEN) return;

    try {
      if (typeof message === "object") {
        message = JSON.stringify(message);
      }
      ws.send(message);
    } catch (e) {
      ws.close();
    }
  }

  // trigger event callbacks
  function trigger(e, args) {
    if (!triggers[e]) return;
    for (var n = 0; n < triggers[e].length; n++) {
      triggers[e][n].apply(triggers[e][n], args || []);
    }
  }

  function parseTextMessage(data) {
    try {
      data = JSON.parse(data);
    } catch (e) {
      return;
    }

    if (data.type === "order") {
      trigger("order_update", [data.data]);
    }
  }

  // parse received binary message. each message is a combination of multiple tick packets
  // [2-bytes num packets][size1][tick1][size2][tick2] ...
  function parseBinary(binpacks) {
    var packets = splitPackets(binpacks),
      ticks = [];

    for (var n = 0; n < packets.length; n++) {
      var bin = packets[n],
        instrument_token = buf2long(bin.slice(0, 4)),
        segment = instrument_token & 0xff;

      var tradable = true;
      if (segment === Indices) tradable = false;

      var divisor = 100.0;
      if (segment === NseCD) divisor = 10000000.0;

      // Parse LTP
      if (bin.byteLength === 8) {
        ticks.push({
          tradable: tradable,
          mode: modeLTP,
          instrument_token: instrument_token,
          last_price: buf2long(bin.slice(4, 8)) / divisor,
          date: new Date().toISOString(),
        });
        // Parse indices quote and full mode
      } else if (bin.byteLength === 28 || bin.byteLength === 32) {
        var mode = modeQuote;
        if (bin.byteLength === 32) mode = modeFull;

        var tick = {
          tradable: tradable,
          mode: mode,
          instrument_token: instrument_token,
          last_price: buf2long(bin.slice(4, 8)) / divisor,
          ohlc: {
            high: buf2long(bin.slice(8, 12)) / divisor,
            low: buf2long(bin.slice(12, 16)) / divisor,
            open: buf2long(bin.slice(16, 20)) / divisor,
            close: buf2long(bin.slice(20, 24)) / divisor,
          },
          change: buf2long(bin.slice(24, 28)),
          date: new Date().toISOString(),
        };

        // Compute the change price using close price and last price
        if (tick.ohlc.close != 0) {
          tick.change =
            ((tick.last_price - tick.ohlc.close) * 100) / tick.ohlc.close;
        }

        // Full mode with timestamp in seconds
        if (bin.byteLength === 32) {
          tick.timestamp = null;
          var timestamp = buf2long(bin.slice(28, 32));
          if (timestamp) tick.timestamp = new Date(timestamp);
        }

        ticks.push(tick);
      } else if (bin.byteLength === 44 || bin.byteLength === 184) {
        var mode = modeQuote;
        if (bin.byteLength === 184) mode = modeFull;

        var tick = {
          tradable: tradable,
          mode: mode,
          instrument_token: instrument_token,
          last_price: buf2long(bin.slice(4, 8)) / divisor,
          last_quantity: buf2long(bin.slice(8, 12)),
          average_price: buf2long(bin.slice(12, 16)) / divisor,
          volume: buf2long(bin.slice(16, 20)),
          buy_quantity: buf2long(bin.slice(20, 24)),
          sell_quantity: buf2long(bin.slice(24, 28)),
          ohlc: {
            open: buf2long(bin.slice(28, 32)) / divisor,
            high: buf2long(bin.slice(32, 36)) / divisor,
            low: buf2long(bin.slice(36, 40)) / divisor,
            close: buf2long(bin.slice(40, 44)) / divisor,
          },
          date: new Date().toISOString(),
        };

        // Compute the change price using close price and last price
        if (tick.ohlc.close != 0) {
          tick.change =
            ((tick.last_price - tick.ohlc.close) * 100) / tick.ohlc.close;
        }

        // Parse full mode
        if (bin.byteLength === 184) {
          // Parse last trade time
          tick.last_trade_time = null;
          var last_trade_time = buf2long(bin.slice(44, 48));
          if (last_trade_time)
            tick.last_trade_time = new Date(last_trade_time * 1000);

          // Parse timestamp
          tick.timestamp = null;
          var timestamp = buf2long(bin.slice(60, 64));
          if (timestamp) tick.timestamp = new Date(timestamp * 1000);

          // Parse OI
          tick.oi = buf2long(bin.slice(48, 52));
          tick.oi_day_high = buf2long(bin.slice(52, 56));
          tick.oi_day_low = buf2long(bin.slice(56, 60));
          tick.depth = {
            buy: [],
            sell: [],
          };

          var s = 0,
            depth = bin.slice(64, 184);
          for (var i = 0; i < 10; i++) {
            s = i * 12;
            tick.depth[i < 5 ? "buy" : "sell"].push({
              quantity: buf2long(depth.slice(s, s + 4)),
              price: buf2long(depth.slice(s + 4, s + 8)) / divisor,
              orders: buf2long(depth.slice(s + 8, s + 10)),
            });
          }
        }

        ticks.push(tick);
      }
    }

    return ticks;
  }

  // split one long binary message into individual tick packets
  function splitPackets(bin) {
    // number of packets
    var num = buf2long(bin.slice(0, 2)),
      j = 2,
      packets = [];

    for (var i = 0; i < num; i++) {
      // first two bytes is the packet length
      var size = buf2long(bin.slice(j, j + 2)),
        packet = bin.slice(j + 2, j + 2 + size);

      packets.push(packet);

      j += 2 + size;
    }

    return packets;
  }

  function attemptReconnection() {
    // Try reconnecting only so many times.
    if (current_reconnection_count > reconnect_max_tries) {
      trigger("noreconnect");
      process.exit(1);
    }

    if (current_reconnection_count > 0) {
      last_reconnect_interval = Math.pow(2, current_reconnection_count);
    } else if (!last_reconnect_interval) {
      last_reconnect_interval = 1;
    }

    if (last_reconnect_interval > reconnect_max_delay) {
      last_reconnect_interval = reconnect_max_delay;
    }

    current_reconnection_count++;

    trigger("reconnect", [current_reconnection_count, last_reconnect_interval]);

    reconnect_timer = setTimeout(function () {
      self.connect();
    }, last_reconnect_interval * 1000);
  }

  // Big endian byte array to long.
  function buf2long(buf) {
    var b = new Uint8Array(buf),
      val = 0,
      len = b.length;

    for (var i = 0, j = len - 1; i < len; i++, j--) {
      val += b[j] << (i * 8);
    }

    return val;
  }

  // de-duplicate an array
  function arrayUnique() {
    var u = {},
      a = [];
    for (var i = 0, l = this.length; i < l; ++i) {
      if (u.hasOwnProperty(this[i])) {
        continue;
      }

      a.push(this[i]);
      u[this[i]] = 1;
    }

    return a;
  }

  var self = this;
};
