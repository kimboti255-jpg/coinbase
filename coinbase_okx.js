// 1. DURABLE OBJECT CLASS YA KUSIMAMIA WEBSOCKET NA INTERVAL
export class WhaleTrackerDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
    this.interval = null;

    // Anzisha interval ya kuvuta data kila baada ya sekunde 5 (unaweza kubadilisha muda)
    this.state.blockConcurrencyWhile(async () => {
      this.startInterval();
    });
  }

  startInterval() {
    if (this.interval) return;

    this.interval = setInterval(async () => {
      if (this.sessions.size === 0) return; // Kama hakuna mtumiaji aliyeunganishwa, usipoteze rasilimali

      try {
        const data = await this.fetchWhaleOrdersData();
        const message = JSON.stringify(data, null, 2);

        // Tuma data kwa kila mteja aliyeko active kwenye WebSocket
        for (const session of this.sessions) {
          try {
            session.send(message);
          } catch (err) {
            // Kama muunganisho umekufa, mtoe kwenye list
            this.sessions.delete(session);
          }
        }
      } catch (err) {
        console.error("Kosa kwenye interval:", err);
      }
    }, 5000); // Kila baada ya sekunde 5
  }

  async fetchWhaleOrdersData() {
    const now = Math.floor(Date.now() / 1000);
    const okxUrl = "https://www.okx.com/api/v5/market/books?instId=BTC-USDT&sz=5000";
    const coinbaseUrl = "https://api.exchange.coinbase.com/products/DOGE-USD/book?level=2";

    const [okxRes, coinbaseRes] = await Promise.all([
      fetch(okxUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }),
      fetch(coinbaseUrl, { headers: { 'User-Agent': 'PHP-Coinbase-Tracker', 'Accept': 'application/json' } })
    ]);

    const MIN_USD_VALUE = 1000000;
    const LIMIT_PER_SIDE = 5000;

    const okxRows = [];
    const coinbaseRows = [];

    if (okxRes.ok) {
      const okxData = await okxRes.json();
      if (okxData.code === '0' && okxData.data && okxData.data[0]) {
        const bookData = okxData.data[0];
        const rawBids = (bookData.bids || []).slice(0, LIMIT_PER_SIDE);
        const rawAsks = (bookData.asks || []).slice(0, LIMIT_PER_SIDE);
        const CONTRACT_SIZE = 1000;

        for (const bid of rawBids) {
          const price = parseFloat(bid[0]);
          const amount = parseFloat(bid[1]) * CONTRACT_SIZE;
          const usdValue = price * amount;
          if (usdValue >= MIN_USD_VALUE) {
            okxRows.push({ price, side: 'bid', amount, value: usdValue });
          }
        }

        for (const ask of rawAsks) {
          const price = parseFloat(ask[0]);
          const amount = parseFloat(ask[1]) * CONTRACT_SIZE;
          const usdValue = price * amount;
          if (usdValue >= MIN_USD_VALUE) {
            okxRows.push({ price, side: 'ask', amount, value: usdValue });
          }
        }
      }
    }

    if (coinbaseRes.ok) {
      const coinbaseData = await coinbaseRes.json();
      if (coinbaseData.bids && coinbaseData.asks) {
        const rawBids = (coinbaseData.bids || []).slice(0, LIMIT_PER_SIDE);
        const rawAsks = (coinbaseData.asks || []).slice(0, LIMIT_PER_SIDE);

        for (const bid of rawBids) {
          const price = parseFloat(bid[0]);
          const amount = parseFloat(bid[1]);
          const usdValue = price * amount;
          if (usdValue >= MIN_USD_VALUE) {
            coinbaseRows.push({ price, side: 'bid', amount, value: usdValue });
          }
        }

        for (const ask of rawAsks) {
          const price = parseFloat(ask[0]);
          const amount = parseFloat(ask[1]);
          const usdValue = price * amount;
          if (usdValue >= MIN_USD_VALUE) {
            coinbaseRows.push({ price, side: 'ask', amount, value: usdValue });
          }
        }
      }
    }

    function formatUsdValue(val) {
      if (val >= 1000000) return '$' + (val / 1000000).toFixed(2) + 'M';
      if (val >= 1000) return '$' + Math.round(val / 1000) + 'K';
      return '$' + val.toFixed(2);
    }

    const formatOrders = (rows, exchangeName) => {
      const bids = [];
      const asks = [];
      for (const row of rows) {
        const formatted = {
          exchange: exchangeName,
          type: row.side,
          price: row.price,
          amount: row.amount,
          value: row.value,
          value_formatted: formatUsdValue(row.value)
        };
        if (row.side === 'bid') bids.push(formatted);
        else asks.push(formatted);
      }
      return { bids, asks };
    };

    const okxFormatted = formatOrders(okxRows, "OKX");
    const coinbaseFormatted = formatOrders(coinbaseRows, "Coinbase");

    return {
      status: "success",
      timestamp: new Date().toISOString(),
      okx: { bids_count: okxFormatted.bids.length, asks_count: okxFormatted.asks.length, bids: okxFormatted.bids, asks: okxFormatted.asks },
      coinbase: { bids_count: coinbaseFormatted.bids.length, asks_count: coinbaseFormatted.asks.length, bids: coinbaseFormatted.bids, asks: coinbaseFormatted.asks }
    };
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return new Response("Tafadhali unganisha kupitia WebSocket (ws:// au wss://)", { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    this.serverAccept(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }

  serverAccept(server) {
    server.accept();
    this.sessions.add(server);

    // Tuma data mara moja mteja anapounganishwa
    this.fetchWhaleOrdersData().then(data => {
      try {
        server.send(JSON.stringify(data, null, 2));
      } catch (e) {}
    });

    server.addEventListener("close", () => {
      this.sessions.delete(server);
    });
  }
}

// 2. WORKER KUU (MAIN FETCH HANDLER)
export default {
  async fetch(request, env, ctx) {
    try {
      // Tunatengeneza ID maalum ya Durable Object (unaweza kutumia ID ya kudumu)
      let id = env.WHALE_TRACKER.idFromName("whale-room");
      let stub = env.WHALE_TRACKER.get(id);

      // Tunaelekeza ombi moja kwa moja kwenye Durable Object
      return await stub.fetch(request);
    } catch (err) {
      return new Response(JSON.stringify({ status: "error", message: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};