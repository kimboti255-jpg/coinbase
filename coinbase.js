export default {
  async fetch(request, env, ctx) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Tafadhali unganisha kupitia WebSocket (ws:// au wss://)", {
        status: 426,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    // DO moja tu (name "global") inashirikiwa na clients wote
    const id = env.WHALE_FEED.idFromName("global");
    const stub = env.WHALE_FEED.get(id);
    return stub.fetch(request);
  }
};

const MIN_USD_VALUE = 100000;    // Filter $100K+
const LIMIT_PER_SIDE = 5000;     // Kikomo cha oda kwa upande
const OKX_CONTRACT_SIZE = 1000;  // 1 DOGE-USDT-SWAP = 1000 DOGE
const ALARM_INTERVAL_MS = 3000;  // Kila sekunde 3

function formatUsdValue(val) {
  if (val >= 1000000) return '$' + (val / 1000000).toFixed(2) + 'M';
  if (val >= 1000)    return '$' + Math.round(val / 1000) + 'K';
  return '$' + val.toFixed(2);
}

export class WhaleFeed {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation API — server.accept() HAPANA, tumia acceptWebSocket
    this.ctx.acceptWebSocket(server);

    // Kama hakuna alarm iliyopangwa, ipange ya kwanza mara moja
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + 50);
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }

  async alarm() {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) {
      return; // Hakuna clients — acha alarm isiendelee
    }

    try {
      const output = await this.buildOrdersPayload();
      const message = JSON.stringify(output);
      for (const ws of sockets) {
        try { ws.send(message); } catch (_) {}
      }
    } catch (err) {
      const errMsg = JSON.stringify({ status: "error", message: err.message });
      for (const ws of sockets) {
        try { ws.send(errMsg); } catch (_) {}
      }
    }

    // Panga alarm inayofuata kama bado kuna clients
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  async webSocketMessage(ws, message) {
    // Client anatuma kitu — tunaweza kupuuza au kujibu hapa
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try { ws.close(code, reason); } catch (_) {}
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAlarm();
    }
  }

  async webSocketError(ws, error) {
    try { ws.close(1011, "WebSocket error"); } catch (_) {}
  }

  async buildOrdersPayload() {
    const okxUrl = "https://www.okx.com/api/v5/market/books-full?instId=DOGE-USDT-SWAP&sz=5000";
    const coinbaseUrl = "https://api.exchange.coinbase.com/products/DOGE-USD/book?level=2";

    const [okxRes, coinbaseRes] = await Promise.all([
      fetch(okxUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json'
        }
      }),
      fetch(coinbaseUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (PHP-Coinbase-Tracker)',
          'Accept': 'application/json'
        }
      })
    ]);

    const okxRows = [];
    const coinbaseRows = [];

    // --- OKX ---
    if (okxRes.ok) {
      const okxData = await okxRes.json();
      if (okxData.code === '0' && okxData.data && okxData.data[0]) {
        const bookData = okxData.data[0];
        const rawBids = (bookData.bids || []).slice();
        const rawAsks = (bookData.asks || []).slice();

        rawBids.sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));
        rawAsks.sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));

        for (const bid of rawBids.slice(0, LIMIT_PER_SIDE)) {
          const price = parseFloat(bid[0]);
          const amount = parseFloat(bid[1]) * OKX_CONTRACT_SIZE;
          const usdValue = price * amount;
          if (usdValue >= MIN_USD_VALUE) {
            okxRows.push({ price, side: 'bid', amount, value: usdValue });
          }
        }
        for (const ask of rawAsks.slice(0, LIMIT_PER_SIDE)) {
          const price = parseFloat(ask[0]);
          const amount = parseFloat(ask[1]) * OKX_CONTRACT_SIZE;
          const usdValue = price * amount;
          if (usdValue >= MIN_USD_VALUE) {
            okxRows.push({ price, side: 'ask', amount, value: usdValue });
          }
        }
      }
    }

    // --- COINBASE ---
    if (coinbaseRes.ok) {
      const coinbaseData = await coinbaseRes.json();
      if (coinbaseData.bids && coinbaseData.asks) {
        const rawBids = (coinbaseData.bids || []).slice();
        const rawAsks = (coinbaseData.asks || []).slice();

        rawBids.sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));
        rawAsks.sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));

        for (const bid of rawBids.slice(0, LIMIT_PER_SIDE)) {
          const price = parseFloat(bid[0]);
          const amount = parseFloat(bid[1]);
          const usdValue = price * amount;
          if (usdValue >= MIN_USD_VALUE) {
            coinbaseRows.push({ price, side: 'bid', amount, value: usdValue });
          }
        }
        for (const ask of rawAsks.slice(0, LIMIT_PER_SIDE)) {
          const price = parseFloat(ask[0]);
          const amount = parseFloat(ask[1]);
          const usdValue = price * amount;
          if (usdValue >= MIN_USD_VALUE) {
            coinbaseRows.push({ price, side: 'ask', amount, value: usdValue });
          }
        }
      }
    }

    const formatOrders = (rows, exchangeName) => {
      const bids = [];
      const asks = [];
      for (const row of rows) {
        const formattedOrder = {
          exchange: exchangeName,
          type: row.side,
          price: row.price,
          amount: row.amount,
          value: row.value,
          value_formatted: formatUsdValue(row.value)
        };
        if (row.side === 'bid') bids.push(formattedOrder);
        else asks.push(formattedOrder);
      }
      return { bids, asks };
    };

    const okxFormatted = formatOrders(okxRows, "OKX");
    const coinbaseFormatted = formatOrders(coinbaseRows, "Coinbase");

    return {
      status: "success",
      timestamp: new Date().toISOString(),
      okx: {
        bids_count: okxFormatted.bids.length,
        asks_count: okxFormatted.asks.length,
        bids: okxFormatted.bids,
        asks: okxFormatted.asks
      },
      coinbase: {
        bids_count: coinbaseFormatted.bids.length,
        asks_count: coinbaseFormatted.asks.length,
        bids: coinbaseFormatted.bids,
        asks: coinbaseFormatted.asks
      }
    };
  }
}