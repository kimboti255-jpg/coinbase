export default {
  async fetch(request, env, ctx) {
    // Angalia kama ombi ni la WebSocket (Upgrade header)
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return new Response("Tafadhali unganisha kupitia WebSocket (ws:// au wss://)", { 
        status: 426,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    server.accept();

    // Kazi ya kukusanya na kutuma data kupitia WebSocket
    async function fetchAndSendWhaleOrders() {
      const now = Math.floor(Date.now() / 1000);

      try {
        // 2. KUVUTA DATA KUTOKA OKX NA COINBASE KWA WAKATI MMOJA
        const okxUrl = "https://www.okx.com/api/v5/market/books-full?instId=DOGE-USDT-SWAP&sz=5000";
        const coinbaseUrl = "https://api.exchange.coinbase.com/products/DOGE-USD/book?level=2";

        const [okxRes, coinbaseRes] = await Promise.all([
          fetch(okxUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' } }),
          fetch(coinbaseUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (PHP-Coinbase-Tracker)', 'Accept': 'application/json' } })
        ]);

        const MIN_USD_VALUE = 100000; // Filter ya $300K+
        const LIMIT_PER_SIDE = 5000;  // LIMIT YA ODA 5000

        const okxRows = [];
        const coinbaseRows = [];

        // --- PROCESS OKX DATA ---
        if (okxRes.ok) {
          const okxData = await okxRes.json();
          if (okxData.code === '0' && okxData.data && okxData.data[0]) {
            const bookData = okxData.data[0];
            const rawBids = bookData.bids || [];
            const rawAsks = bookData.asks || [];

            rawBids.sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));
            rawAsks.sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));

            const limitedBids = rawBids.slice(0, LIMIT_PER_SIDE);
            const limitedAsks = rawAsks.slice(0, LIMIT_PER_SIDE);
            
            const CONTRACT_SIZE = 1000; // Mkataba 1 wa DOGE-USDT-SWAP OKX = 1000 DOGE

            for (const bid of limitedBids) {
              const price = parseFloat(bid[0]);
              const amount = parseFloat(bid[1]) * CONTRACT_SIZE;
              const usdValue = price * amount;
              
              if (usdValue >= MIN_USD_VALUE) {
                okxRows.push({ price, side: 'bid', amount, value: usdValue, first_seen: now });
              }
            }

            for (const ask of limitedAsks) {
              const price = parseFloat(ask[0]);
              const amount = parseFloat(ask[1]) * CONTRACT_SIZE;
              const usdValue = price * amount;
              
              if (usdValue >= MIN_USD_VALUE) {
                okxRows.push({ price, side: 'ask', amount, value: usdValue, first_seen: now });
              }
            }
          }
        }

        // --- PROCESS COINBASE DATA ---
        if (coinbaseRes.ok) {
          const coinbaseData = await coinbaseRes.json();
          if (coinbaseData.bids && coinbaseData.asks) {
            const rawBids = coinbaseData.bids || [];
            const rawAsks = coinbaseData.asks || [];

            rawBids.sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));
            rawAsks.sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));

            const limitedBids = rawBids.slice(0, LIMIT_PER_SIDE);
            const limitedAsks = rawAsks.slice(0, LIMIT_PER_SIDE);

            for (const bid of limitedBids) {
              const price = parseFloat(bid[0]);
              const amount = parseFloat(bid[1]);
              const usdValue = price * amount;
              
              if (usdValue >= MIN_USD_VALUE) {
                coinbaseRows.push({ price, side: 'bid', amount, value: usdValue, first_seen: now });
              }
            }

            for (const ask of limitedAsks) {
              const price = parseFloat(ask[0]);
              const amount = parseFloat(ask[1]);
              const usdValue = price * amount;
              
              if (usdValue >= MIN_USD_VALUE) {
                coinbaseRows.push({ price, side: 'ask', amount, value: usdValue, first_seen: now });
              }
            }
          }
        }

        // 3. FUNCTION YA FORMAT USD
        function formatUsdValue(val) {
          if (val >= 1000000) {
            return '$' + (val / 1000000).toFixed(2) + 'M';
          } else if (val >= 1000) {
            return '$' + Math.round(val / 1000) + 'K';
          }
          return '$' + val.toFixed(2);
        }

        // 4. KUCHUKUA NA KUPANGA DATA
        const formatOrders = (rows, exchangeName) => {
          const bids = [];
          const asks = [];

          for (const row of rows) {
            const durationSeconds = now - row.first_seen;
            const durationMinutes = Math.round((durationSeconds / 60) * 10) / 10;
            const firstSeenIso = new Date(row.first_seen * 1000).toISOString();

            const formattedOrder = {
              id: row.side + "-" + row.price,
              exchange: exchangeName,
              type: row.side,
              price: row.price,
              amount: row.amount,
              value: row.value,
              value_formatted: formatUsdValue(row.value),
              duration_minutes: durationMinutes,
              first_seen_iso: firstSeenIso
            };

            if (row.side === 'bid') {
              bids.push(formattedOrder);
            } else {
              asks.push(formattedOrder);
            }
          }
          return { bids, asks };
        };

        const okxFormatted = formatOrders(okxRows, "OKX");
        const coinbaseFormatted = formatOrders(coinbaseRows, "Coinbase");

        const output = {
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

        server.send(JSON.stringify(output, null, 2));

      } catch (err) {
        server.send(JSON.stringify({ status: "error", message: err.message }));
      }
    }

    // Tuma data mara moja pindi WebSocket inapounganishwa
    fetchAndSendWhaleOrders();

    // Hiari: Unaweza pia kuweka interval ya kutuma data mpya kila baada ya muda fulani (mfano kila sekunde 10)
    const interval = setInterval(fetchAndSendWhaleOrders, 3000);

    server.addEventListener("close", () => {
      clearInterval(interval);
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }
};
