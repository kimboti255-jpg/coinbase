export default {
  async fetch(request, env, ctx) {
    const now = Math.floor(Date.now() / 1000);

    try {
      // 1. KUTENGENEZA TABLES MBILI KWENYE D1 DATABASE KAMA HAZIPO
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS active_orders_okx (
            price REAL PRIMARY KEY,
            side TEXT,
            amount REAL,
            value REAL,
            first_seen INTEGER,
            last_seen INTEGER
        )
      `).run();

      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS active_orders_coinbase (
            price REAL PRIMARY KEY,
            side TEXT,
            amount REAL,
            value REAL,
            first_seen INTEGER,
            last_seen INTEGER
        )
      `).run();

      // 2. KUVUTA DATA KUTOKA OKX NA COINBASE KWA WAKATI MMOJA
      const okxUrl = "https://www.okx.com/api/v5/market/books-full?instId=DOGE-USDT-SWAP&sz=5000";
      const coinbaseUrl = "https://api.exchange.coinbase.com/products/DOGE-USD/book?level=2";

      const [okxRes, coinbaseRes] = await Promise.all([
        fetch(okxUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' } }),
        fetch(coinbaseUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (PHP-Coinbase-Tracker)', 'Accept': 'application/json' } })
      ]);

      const MIN_USD_VALUE = 100000; // Filter ya $300K+
      const LIMIT_PER_SIDE = 5000;  // LIMIT YA ODA 5000

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
          
          const validPricesOkx = [];
          const rawLargeOrdersOkx = {};
          const CONTRACT_SIZE = 1000; // Mkataba 1 wa DOGE-USDT-SWAP OKX = 1000 DOGE

          for (const bid of limitedBids) {
            const price = parseFloat(bid[0]);
            const amount = parseFloat(bid[1]) * CONTRACT_SIZE;
            const usdValue = price * amount;
            
            // Tunachukua bei zote zilizofikisha $300K+ ili kuzihifadhi/kusasisha
            if (usdValue >= MIN_USD_VALUE) {
              validPricesOkx.push(price);
              rawLargeOrdersOkx[price.toString()] = { side: 'bid', price, amount, value: usdValue };
            }
          }

          for (const ask of limitedAsks) {
            const price = parseFloat(ask[0]);
            const amount = parseFloat(ask[1]) * CONTRACT_SIZE;
            const usdValue = price * amount;
            
            if (usdValue >= MIN_USD_VALUE) {
              validPricesOkx.push(price);
              rawLargeOrdersOkx[price.toString()] = { side: 'ask', price, amount, value: usdValue };
            }
          }

          // FUTA ODA ZOTE AMBAZO HAZIPO TENA AU ZIMESHUKA CHINI YA $300K KWENYE EXCHANGE
          if (validPricesOkx.length > 0) {
            const placeholders = validPricesOkx.map(() => '?').join(',');
            await env.DB.prepare(`DELETE FROM active_orders_okx WHERE price NOT IN (${placeholders})`).bind(...validPricesOkx).run();
          } else {
            await env.DB.prepare(`DELETE FROM active_orders_okx`).run();
          }

          for (const priceStr in rawLargeOrdersOkx) {
            const order = rawLargeOrdersOkx[priceStr];
            const priceFloat = parseFloat(priceStr);
            const existing = await env.DB.prepare(`SELECT first_seen FROM active_orders_okx WHERE price = ?`).bind(priceFloat).first();
            const firstSeen = existing ? existing.first_seen : now;

            await env.DB.prepare(`
              INSERT OR REPLACE INTO active_orders_okx (price, side, amount, value, first_seen, last_seen) 
              VALUES (?, ?, ?, ?, ?, ?)
            `).bind(priceFloat, order.side, order.amount, order.value, firstSeen, now).run();
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
          
          const validPricesCoinbase = [];
          const rawLargeOrdersCoinbase = {};

          for (const bid of limitedBids) {
            const price = parseFloat(bid[0]);
            const amount = parseFloat(bid[1]);
            const usdValue = price * amount;
            
            if (usdValue >= MIN_USD_VALUE) {
              validPricesCoinbase.push(price);
              rawLargeOrdersCoinbase[price.toString()] = { side: 'bid', price, amount, value: usdValue };
            }
          }

          for (const ask of limitedAsks) {
            const price = parseFloat(ask[0]);
            const amount = parseFloat(ask[1]);
            const usdValue = price * amount;
            
            if (usdValue >= MIN_USD_VALUE) {
              validPricesCoinbase.push(price);
              rawLargeOrdersCoinbase[price.toString()] = { side: 'ask', price, amount, value: usdValue };
            }
          }

          // FUTA ODA ZOTE AMBAZO HAZIPO TENA AU ZIMESHUKA CHINI YA $300K KWENYE EXCHANGE
          if (validPricesCoinbase.length > 0) {
            const placeholders = validPricesCoinbase.map(() => '?').join(',');
            await env.DB.prepare(`DELETE FROM active_orders_coinbase WHERE price NOT IN (${placeholders})`).bind(...validPricesCoinbase).run();
          } else {
            await env.DB.prepare(`DELETE FROM active_orders_coinbase`).run();
          }

          for (const priceStr in rawLargeOrdersCoinbase) {
            const order = rawLargeOrdersCoinbase[priceStr];
            const priceFloat = parseFloat(priceStr);
            const existing = await env.DB.prepare(`SELECT first_seen FROM active_orders_coinbase WHERE price = ?`).bind(priceFloat).first();
            const firstSeen = existing ? existing.first_seen : now;

            await env.DB.prepare(`
              INSERT OR REPLACE INTO active_orders_coinbase (price, side, amount, value, first_seen, last_seen) 
              VALUES (?, ?, ?, ?, ?, ?)
            `).bind(priceFloat, order.side, order.amount, order.value, firstSeen, now).run();
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

      // 4. KUCHUKUA NA KUPANGA DATA KUTOKA KWENYE DATABASE ZOTE MBILI
      const { results: okxRows } = await env.DB.prepare(`SELECT * FROM active_orders_okx ORDER BY price DESC`).all();
      const { results: coinbaseRows } = await env.DB.prepare(`SELECT * FROM active_orders_coinbase ORDER BY price DESC`).all();

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

      return new Response(JSON.stringify(output, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });

    } catch (err) {
      return new Response(JSON.stringify({ status: "error", message: err.message }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};