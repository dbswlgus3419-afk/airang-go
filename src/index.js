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

    // =====================================================
    // 0. 런타임 Secret 확인용
    // =====================================================
    if (
      url.pathname === "/api/env-check" ||
      url.pathname === "/api/env-check/"
    ) {
      return json({
        hasClientId: !!env.NAVER_CLIENT_ID,
        hasClientSecret: !!env.NAVER_CLIENT_SECRET
      });
    }

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

    // =====================================================
    // 1. 네이버 블로그 후기
    // - 1차: 장소명
    // - 2차: 장소명 + 후기
    // - 3차: 장소명 + 지역
    // - 0건이면 자동으로 다음 검색어 시도
    // =====================================================
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
          .slice(0, 2)
          .join(" ");

        const queryCandidates = [
          place,
          `${place} 후기`,
          areaTokens ? `${place} ${areaTokens}` : "",
          areaTokens ? `${place.replace(/\s*(점|지점)$/,"")} ${areaTokens}` : ""
        ]
          .map(v => v.trim())
          .filter(Boolean)
          .filter((v, i, a) => a.indexOf(v) === i);

        async function searchBlog(query) {
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

            const err = new Error("네이버 블로그 검색 API 호출 실패");
            err.status = response.status;
            err.detail = detail;
            throw err;
          }

          try {
            return JSON.parse(raw);
          } catch (_) {
            throw new Error("네이버 API 응답을 JSON으로 읽지 못했습니다.");
          }
        }

        let data = null;
        let query = queryCandidates[0];

        for (const candidate of queryCandidates) {
          const result = await searchBlog(candidate);
          data = result;
          query = candidate;

          if (
            Number(result?.total || 0) > 0 ||
            (Array.isArray(result?.items) && result.items.length > 0)
          ) {
            break;
          }
        }

        const items = Array.isArray(data?.items) ? data.items : [];

        // 사람이 읽기 쉬운 "반응 주제" 사전
        const topicDefs = [
          { key:"recommend", label:"추천·만족", tone:"positive", words:["추천","만족","재방문","가볼만","최고","좋았","좋아요","좋은"] },
          { key:"kids", label:"아이 반응 좋음", tone:"positive", words:["아이들이 좋아","아이가 좋아","아이랑 좋","아이와 좋","재밌","재미","즐거"] },
          { key:"facility", label:"시설·공간 만족", tone:"positive", words:["깨끗","쾌적","넓","예쁘","시설 좋","공간 좋"] },
          { key:"program", label:"체험·프로그램 만족", tone:"positive", words:["알차","유익","체험 좋","프로그램 좋","볼거리","놀거리"] },
          { key:"service", label:"친절·서비스 만족", tone:"positive", words:["친절","서비스 좋","응대 좋"] },

          { key:"wait", label:"대기·혼잡", tone:"negative", words:["대기","웨이팅","혼잡","복잡","사람 많","붐비"] },
          { key:"price", label:"가격 부담", tone:"negative", words:["비싸","비쌈","가격 부담","비싼"] },
          { key:"parking", label:"주차·접근 불편", tone:"negative", words:["주차 힘","주차 어렵","주차 불편","접근 불편"] },
          { key:"space", label:"공간·시설 아쉬움", tone:"negative", words:["좁","노후","관리 안","시설 아쉽"] },
          { key:"serviceBad", label:"서비스 아쉬움", tone:"negative", words:["불친절","응대 아쉽","서비스 아쉽"] },
          { key:"environment", label:"환경 불편", tone:"negative", words:["냄새","시끄","덥","춥"] },

          { key:"info", label:"운영·이용 정보", tone:"neutral", words:["운영시간","이용시간","예약","요금","입장료","휴무","주차장","위치"] },
          { key:"intro", label:"장소·시설 소개", tone:"neutral", words:["소개","정보","시설","프로그램","수업","교육","체험"] }
        ];

        function analyseItem(item){
          const text = (stripHtml(item.title) + " " + stripHtml(item.description)).toLowerCase();
          const matched = [];
          let p = 0, n = 0;

          for (const topic of topicDefs){
            let hits = 0;
            for (const raw of topic.words){
              const w = raw.toLowerCase();
              if (text.includes(w)) hits += 1;
            }
            if (hits){
              matched.push({ key:topic.key, label:topic.label, tone:topic.tone, hits });
              if (topic.tone === "positive") p += hits;
              if (topic.tone === "negative") n += hits;
            }
          }

          let tone = "neutral";
          if (p > n) tone = "positive";
          else if (n > p) tone = "negative";

          return { item, text, tone, matched };
        }

        const analysed = items.map(analyseItem);
        const groups = {
          positive: analysed.filter(x => x.tone === "positive"),
          neutral: analysed.filter(x => x.tone === "neutral"),
          negative: analysed.filter(x => x.tone === "negative")
        };

        const sampleSize = analysed.length;
        const enoughData = sampleSize >= 5;

        const toPercent = (n) =>
          sampleSize ? Math.round((n / sampleSize) * 100) : 0;

        const positivePct = enoughData ? toPercent(groups.positive.length) : 0;
        const negativePct = enoughData ? toPercent(groups.negative.length) : 0;
        const neutralPct = enoughData
          ? Math.max(0, 100 - positivePct - negativePct)
          : 0;

        function topicCountsFor(group){
          const map = new Map();
          for (const row of group){
            for (const t of row.matched){
              // 해당 감정 그룹에 맞는 톤의 주제만 우선 집계.
              // 중립 그룹에서는 neutral 주제를, 없으면 기타 정보성으로 처리.
              if (
                (row.tone === "positive" && t.tone === "positive") ||
                (row.tone === "negative" && t.tone === "negative") ||
                (row.tone === "neutral" && t.tone === "neutral")
              ){
                map.set(t.label, (map.get(t.label) || 0) + 1);
              }
            }
          }
          return [...map.entries()]
            .sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0],"ko"))
            .map(([label,count]) => ({label,count}));
        }

        const topicGroups = {
          positive: topicCountsFor(groups.positive),
          neutral: topicCountsFor(groups.neutral),
          negative: topicCountsFor(groups.negative)
        };

        function oneLineSummary(tone, count, topics){
          if (!count) {
            if (tone === "positive") return "뚜렷한 긍정 반응은 아직 많지 않아요.";
            if (tone === "negative") return "뚜렷한 불편·아쉬움 반응은 거의 없어요.";
            return "정보성·일반 언급으로 분류된 글은 많지 않아요.";
          }
          const top = topics.slice(0,2).map(x=>x.label);
          if (tone === "positive"){
            return top.length
              ? `${top.join("과 ")}에 대한 긍정 반응이 주로 보여요.`
              : "전반적으로 만족하거나 추천하는 반응이 보여요.";
          }
          if (tone === "negative"){
            return top.length
              ? `${top.join("과 ")} 관련 아쉬움이 일부 보여요.`
              : "일부 후기에서 불편하거나 아쉽다는 반응이 보여요.";
          }
          return top.length
            ? `${top.join("과 ")} 중심의 정보성 글이 많아요.`
            : "장소 소개·이용 정보 중심의 중립적인 글이 많아요.";
        }

        // 화면 하단용: 사람이 알아보기 쉬운 주요 반응 키워드
        const readableKeywords = [
          ...topicGroups.positive.slice(0,3).map(x=>({...x,tone:"positive"})),
          ...topicGroups.neutral.slice(0,2).map(x=>({...x,tone:"neutral"})),
          ...topicGroups.negative.slice(0,3).map(x=>({...x,tone:"negative"}))
        ].sort((a,b)=>b.count-a.count).slice(0,6);

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
          attemptedQueries: queryCandidates,
          total: Number(data?.total || 0),
          reviews,
          sentiment: {
            positive: positivePct,
            neutral: neutralPct,
            negative: negativePct,
            sampleSize,
            enoughData,
            minimumSampleSize: 5,
            basis: "네이버 블로그 검색 상위 최대 20건의 제목·요약문 기준 자동 분류"
          },
          sentimentDetails: {
            positive: {
              count: groups.positive.length,
              summary: oneLineSummary("positive", groups.positive.length, topicGroups.positive)
            },
            neutral: {
              count: groups.neutral.length,
              summary: oneLineSummary("neutral", groups.neutral.length, topicGroups.neutral)
            },
            negative: {
              count: groups.negative.length,
              summary: oneLineSummary("negative", groups.negative.length, topicGroups.negative)
            }
          },
          reactionKeywords: readableKeywords
        });

      } catch (error) {
        return json(
          {
            ok: false,
            error: error?.message || "블로그 후기를 불러오지 못했습니다.",
            status: error?.status || 500,
            detail: error?.detail || ""
          },
          { status: error?.status ? 502 : 500 }
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
