export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const json = (data, init = {}) =>
      new Response(JSON.stringify(data), {
        ...init,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          ...(init.headers || {})
        }
      });

    const stripHtml = (v = "") =>
      String(v)
        .replace(/<[^>]*>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&#x27;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();

    if (url.pathname === "/api/test" || url.pathname === "/api/test/") {
      return json({
        ok: true,
        message: "아이랑 어디갈까 API 정상 작동!",
        time: new Date().toISOString()
      });
    }

    if (
      url.pathname === "/api/blog-reviews" ||
      url.pathname === "/api/blog-reviews/"
    ) {
      const place = (url.searchParams.get("place") || "").trim();
      const address = (url.searchParams.get("address") || "").trim();

      if (!place) {
        return json(
          { ok: false, error: "place 파라미터가 필요합니다." },
          { status: 400 }
        );
      }

      if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) {
        return json(
          {
            ok: false,
            needsSetup: true,
            error: "NAVER API HUB 인증정보가 설정되지 않았습니다."
          },
          { status: 503 }
        );
      }

      try {
        const areaTokens = address
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 3)
          .join(" ");

        const query = [place, areaTokens, "후기"].filter(Boolean).join(" ");

        const apiUrl =
          "https://naverapihub.apigw.ntruss.com/search/v1/blog" +
          "?query=" + encodeURIComponent(query) +
          "&display=20&start=1&sort=sim&format=json";

        const response = await fetch(apiUrl, {
          headers: {
            "X-NCP-APIGW-API-KEY-ID": env.NAVER_CLIENT_ID,
            "X-NCP-APIGW-API-KEY": env.NAVER_CLIENT_SECRET
          }
        });

        const raw = await response.text();

        if (!response.ok) {
          let detail = raw;
          try {
            const parsed = JSON.parse(raw);
            detail =
              parsed?.errorMessage ||
              parsed?.message ||
              parsed?.error?.message ||
              raw;
          } catch (_) {}

          return json(
            {
              ok: false,
              error: "네이버 블로그 검색 API 호출 실패",
              status: response.status,
              detail
            },
            { status: 502 }
          );
        }

        let data;
        try {
          data = JSON.parse(raw);
        } catch (_) {
          return json(
            {
              ok: false,
              error: "네이버 API 응답을 JSON으로 읽지 못했습니다."
            },
            { status: 502 }
          );
        }

        const items = Array.isArray(data.items) ? data.items : [];

        const positiveWords = [
          "좋", "추천", "만족", "재방문", "깨끗", "친절", "재밌", "재미",
          "즐거", "훌륭", "편하", "넓", "예쁘", "알차", "유익", "최고",
          "아이랑 좋", "아이와 좋", "가볼만", "만족도"
        ];

        const negativeWords = [
          "아쉽", "불편", "비싸", "비쌈", "대기", "혼잡", "복잡", "좁",
          "별로", "실망", "불친절", "주차 힘", "주차 어렵", "웨이팅",
          "냄새", "시끄", "덥", "춥", "관리 안", "재방문 안"
        ];

        const posCounts = new Map();
        const negCounts = new Map();

        let positive = 0;
        let negative = 0;
        let neutral = 0;

        for (const item of items) {
          const text =
            (stripHtml(item.title) + " " + stripHtml(item.description))
              .toLowerCase();

          let pScore = 0;
          let nScore = 0;

          for (const word of positiveWords) {
            const w = word.toLowerCase();
            if (text.includes(w)) {
              pScore += 1;
              posCounts.set(word, (posCounts.get(word) || 0) + 1);
            }
          }

          for (const word of negativeWords) {
            const w = word.toLowerCase();
            if (text.includes(w)) {
              nScore += 1;
              negCounts.set(word, (negCounts.get(word) || 0) + 1);
            }
          }

          if (pScore > nScore) positive += 1;
          else if (nScore > pScore) negative += 1;
          else neutral += 1;
        }

        const sampleSize = items.length || 0;
        const toPercent = (n) =>
          sampleSize ? Math.round((n / sampleSize) * 100) : 0;

        const positivePct = toPercent(positive);
        const negativePct = toPercent(negative);
        const neutralPct = Math.max(0, 100 - positivePct - negativePct);

        const topWords = (map, limit = 5) =>
          [...map.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"))
            .slice(0, limit)
            .map(([word, count]) => ({ word, count }));

        const reviews = items.slice(0, 4).map((item) => ({
          title: stripHtml(item.title),
          link: item.link || "",
          description: stripHtml(item.description),
          bloggerName: stripHtml(item.bloggername || ""),
          bloggerLink: item.bloggerlink || "",
          postDate: item.postdate || ""
        }));

        return json({
          ok: true,
          query,
          total: Number(data.total || 0),
          reviews,
          sentiment: {
            positive: positivePct,
            neutral: neutralPct,
            negative: negativePct,
            sampleSize,
            basis: "네이버 블로그 검색 상위 결과의 제목·요약문 키워드 기준"
          },
          keywords: {
            positive: topWords(posCounts),
            negative: topWords(negCounts)
          }
        });
      } catch (error) {
        return json(
          {
            ok: false,
            error: error?.message || "블로그 후기를 불러오지 못했습니다."
          },
          { status: 500 }
        );
      }
    }

    async function getNadrilabHtml() {
      const response = await fetch("https://www.nadrilab.com/recommend", {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 Chrome/120 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8"
        }
      });

      if (!response.ok) {
        throw new Error("나들이랩 요청 실패: " + response.status);
      }

      return await response.text();
    }

    function cleanText(value) {
      return value
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&nbsp;/g, " ")
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
    }

    function parseSnsHot(html) {
      let start = html.indexOf("인스타그램");
      if (start === -1) start = html.indexOf("오늘의 SNS 핫플");
      if (start === -1) start = 0;

      const snsHtml = html.slice(start);
      const regex =
        /<a\b[^>]*href=["']([^"']*\/places\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

      const places = [];
      const seen = new Set();
      let match;

      while ((match = regex.exec(snsHtml)) !== null) {
        let name = cleanText(match[2]);
        const href = match[1];

        name = name.replace(/^\s*\d+\s*/, "");

        if (!name || name.length < 2 || seen.has(name)) continue;

        seen.add(name);
        places.push({
          name,
          url: href.startsWith("http")
            ? href
            : "https://www.nadrilab.com" + href
        });

        if (places.length >= 18) break;
      }

      return {
        instagram: places.slice(0, 6),
        youtube: places.slice(6, 12),
        shorts: places.slice(12, 18)
      };
    }

    if (
      url.pathname === "/api/sns-debug" ||
      url.pathname === "/api/sns-debug/"
    ) {
      try {
        const html = await getNadrilabHtml();
        const result = parseSnsHot(html);

        return json({
          ok: true,
          htmlLength: html.length,
          instagramCount: result.instagram.length,
          youtubeCount: result.youtube.length,
          shortsCount: result.shorts.length,
          result
        });
      } catch (error) {
        return json(
          { ok: false, error: error?.message || "SNS 디버그 실패" },
          { status: 500 }
        );
      }
    }

    if (
      url.pathname === "/api/sns-hot" ||
      url.pathname === "/api/sns-hot/"
    ) {
      try {
        const html = await getNadrilabHtml();
        const result = parseSnsHot(html);

        return json({
          ok: true,
          source: "nadrilab",
          fetchedAt: new Date().toISOString(),
          instagram: result.instagram,
          youtube: result.youtube,
          shorts: result.shorts
        });
      } catch (error) {
        return json(
          { ok: false, error: error?.message || "SNS 핫플 조회 실패" },
          { status: 500 }
        );
      }
    }

    return env.ASSETS.fetch(request);
  }
};
