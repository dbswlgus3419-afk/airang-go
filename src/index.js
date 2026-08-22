export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/test" || url.pathname === "/api/test/") {
      return Response.json({
        ok: true,
        message: "아이랑 어디갈까 API 정상 작동!",
        time: new Date().toISOString()
      });
    }

    function cleanText(value) {
      return String(value || "")
        .replace(/<b>/gi, "")
        .replace(/<\/b>/gi, "")
        .replace(/&amp;/g, "&")
        .replace(/&nbsp;/g, " ")
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
    }

    // =====================================================
    // 네이버 블로그 후기 API
    // =====================================================
    if (url.pathname === "/api/blog-reviews" || url.pathname === "/api/blog-reviews/") {
      try {
        const place = (url.searchParams.get("place") || "").trim();
        const address = (url.searchParams.get("address") || "").trim();

        if (!place) {
          return Response.json({ ok: false, error: "장소명이 필요해요." }, { status: 400 });
        }

        if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) {
          return Response.json({
            ok: false,
            needsSetup: true,
            error: "네이버 검색 API 키가 아직 Cloudflare에 등록되지 않았어요."
          }, { status: 503 });
        }

        // 동명이인 장소를 줄이기 위해 주소 앞부분을 검색어에 함께 사용
        const region = address.split(/\s+/).slice(0, 2).join(" ");
        const query = [place, region, "후기"].filter(Boolean).join(" ");
        const apiUrl = new URL("https://openapi.naver.com/v1/search/blog.json");
        apiUrl.searchParams.set("query", query);
        apiUrl.searchParams.set("display", "20");
        apiUrl.searchParams.set("start", "1");
        apiUrl.searchParams.set("sort", "sim");

        const r = await fetch(apiUrl.toString(), {
          headers: {
            "X-Naver-Client-Id": env.NAVER_CLIENT_ID,
            "X-Naver-Client-Secret": env.NAVER_CLIENT_SECRET,
            "Accept": "application/json"
          }
        });

        if (!r.ok) {
          const body = await r.text();
          return Response.json({
            ok: false,
            error: `네이버 블로그 검색 실패 (${r.status})`,
            detail: body.slice(0, 500)
          }, { status: 502 });
        }

        const data = await r.json();
        const items = (data.items || []).map((item, i) => ({
          rank: i + 1,
          title: cleanText(item.title),
          description: cleanText(item.description),
          link: item.link,
          bloggerName: cleanText(item.bloggername),
          postDate: item.postdate || ""
        }));

        // 제목/요약문 기반의 가벼운 휴리스틱 분류.
        // 실제 본문 전체 감성분석이 아니므로 프론트에서도 이를 명시함.
        const positiveWords = [
          "좋아","좋았","추천","만족","재방문","친절","깨끗","넓","재미","즐거",
          "최고","편리","알차","예쁘","멋지","유익","괜찮","아이들이 좋아","아이랑 좋"
        ];
        const negativeWords = [
          "아쉽","별로","불편","비싸","비쌈","복잡","붐비","대기","기다","좁",
          "더럽","실망","힘들","주차 어렵","예약 어렵","위험","덥","추워","춥","소음"
        ];

        function scoreText(text) {
          let pos = 0, neg = 0;
          for (const w of positiveWords) if (text.includes(w)) pos++;
          for (const w of negativeWords) if (text.includes(w)) neg++;
          if (pos > neg) return "positive";
          if (neg > pos) return "negative";
          return "neutral";
        }

        const counts = { positive: 0, neutral: 0, negative: 0 };
        const posKeywordCount = new Map();
        const negKeywordCount = new Map();

        for (const item of items) {
          const text = `${item.title} ${item.description}`;
          const cls = scoreText(text);
          counts[cls]++;
          for (const w of positiveWords) if (text.includes(w)) posKeywordCount.set(w, (posKeywordCount.get(w) || 0) + 1);
          for (const w of negativeWords) if (text.includes(w)) negKeywordCount.set(w, (negKeywordCount.get(w) || 0) + 1);
        }

        const denom = Math.max(1, items.length);
        const pct = n => Math.round((n / denom) * 100);
        const topKeywords = map => [...map.entries()]
          .sort((a,b) => b[1] - a[1])
          .slice(0, 4)
          .map(([word, count]) => ({ word, count }));

        return Response.json({
          ok: true,
          source: "naver-blog-search",
          query,
          fetchedAt: new Date().toISOString(),
          total: Number(data.total || 0),
          sentiment: {
            positive: pct(counts.positive),
            neutral: pct(counts.neutral),
            negative: pct(counts.negative),
            sampleSize: items.length,
            basis: "블로그 검색 결과의 제목·요약문 키워드 기준"
          },
          keywords: {
            positive: topKeywords(posKeywordCount),
            negative: topKeywords(negKeywordCount)
          },
          reviews: items.slice(0, 4)
        });
      } catch (error) {
        return Response.json({ ok: false, error: error.message }, { status: 500 });
      }
    }

    // =====================================================
    // 나들이랩 SNS 핫플
    // =====================================================
    async function getNadrilabHtml() {
      const response = await fetch("https://www.nadrilab.com/recommend", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8"
        }
      });
      if (!response.ok) throw new Error("나들이랩 요청 실패: " + response.status);
      return await response.text();
    }

    function htmlText(value) {
      return String(value || "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&nbsp;/g, " ")
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
    }

    function parseSnsHot(html) {
      // SNS 폴라로이드 구역에서 /places/ 링크를 순서대로 수집한 뒤 6개씩 분리
      const snsAnchor = html.indexOf("오늘의 SNS 핫플");
      const start = snsAnchor >= 0 ? snsAnchor : Math.max(0, html.indexOf("인스타그램"));
      const endMarker = html.indexOf("카테고리로 고르기", start);
      const block = html.slice(start, endMarker > start ? endMarker : start + 180000);
      const regex = /<a\b[^>]*href=["']([^"']*\/places\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      const places = [];
      const seen = new Set();
      let match;
      while ((match = regex.exec(block)) !== null) {
        let name = htmlText(match[2]).replace(/^\s*\d+\s*/, "");
        const href = match[1];
        if (!name || name.length < 2 || seen.has(name)) continue;
        seen.add(name);
        places.push({
          name,
          url: href.startsWith("http") ? href : "https://www.nadrilab.com" + href
        });
        if (places.length >= 18) break;
      }
      return {
        instagram: places.slice(0, 6),
        youtube: places.slice(6, 12),
        shorts: places.slice(12, 18)
      };
    }

    if (url.pathname === "/api/sns-debug" || url.pathname === "/api/sns-debug/") {
      try {
        const html = await getNadrilabHtml();
        const result = parseSnsHot(html);
        return Response.json({
          ok: true,
          htmlLength: html.length,
          instagramCount: result.instagram.length,
          youtubeCount: result.youtube.length,
          shortsCount: result.shorts.length,
          result
        });
      } catch (error) {
        return Response.json({ ok: false, error: error.message }, { status: 500 });
      }
    }

    if (url.pathname === "/api/sns-hot" || url.pathname === "/api/sns-hot/") {
      try {
        const html = await getNadrilabHtml();
        const result = parseSnsHot(html);
        return Response.json({
          ok: true,
          source: "nadrilab",
          fetchedAt: new Date().toISOString(),
          instagram: result.instagram,
          youtube: result.youtube,
          shorts: result.shorts
        });
      } catch (error) {
        return Response.json({ ok: false, error: error.message }, { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
