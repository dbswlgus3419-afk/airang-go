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

        // -----------------------------------------------------
        // 반응 분석 v4: "방문 판단 포인트" 중심
        // - 추상 키워드(추천/만족/장소소개) 대신 실제 체감 요소를 표시
        // - 한 글 안에 장점+단점이 함께 있으면 중립/혼합 반응으로 우선 분류
        // - API가 제공하는 제목+요약문만 사용하므로 본문 전체 평가는 아님
        // -----------------------------------------------------
        const aspectDefs = [
          // 아이/재미
          { key:"kidFun", label:"아이 즐거움", pos:["아이가 좋아","아이들이 좋아","아이랑 좋","아이와 좋","재밌","재미있","신나","즐거"], neg:["아이가 지루","아이들이 지루","재미없","시시"] },

          // 온도/환경
          { key:"temperature", label:"온도", pos:["시원","쾌적","선선"], neg:["더워","덥","후텁","답답","추워","춥"] },
          { key:"clean", label:"청결", pos:["깨끗","청결","깔끔"], neg:["더럽","지저분","냄새","청소가 안","관리 안"] },

          // 가격
          { key:"price", label:"가격", pos:["합리적","가성비","가격 괜찮","가격이 괜찮","저렴","혜자"], neg:["비싸","비쌈","가격 부담","비싼","가격이 높"] },

          // 거리/접근
          { key:"distance", label:"거리", pos:["가깝","접근성 좋","찾기 쉽","이동 편"], neg:["멀다","멀어","거리가 멀","찾기 어렵","접근성 아쉽","이동 불편"] },

          // 주차
          { key:"parking", label:"주차", pos:["주차 편","주차가 편","주차장 넓","주차 넓","주차 걱정 없","주차 쉬"], neg:["주차 불편","주차 어렵","주차 힘","주차장 좁","주차 공간 부족"] },

          // 화장실
          { key:"toilet", label:"화장실", pos:["화장실 가까","화장실 편","화장실 깨끗","화장실 많"], neg:["화장실 멀","화장실 불편","화장실 더럽","화장실 부족"] },

          // 대기/혼잡
          { key:"wait", label:"대기", pos:["대기 짧","웨이팅 없","바로 입장"], neg:["대기 길","웨이팅","기다림","줄이 길"] },
          { key:"crowd", label:"혼잡도", pos:["한적","여유롭","사람 적"], neg:["붐비","혼잡","사람 많","복잡"] },

          // 공간
          { key:"space", label:"공간", pos:["넓","공간 넉넉","쾌적"], neg:["좁","답답","공간 부족"] },
          { key:"rest", label:"휴식공간", pos:["쉴 곳 많","앉을 곳 많","의자 많","휴게공간"], neg:["쉴 곳 없","앉을 곳 없","의자 부족"] },

          // 프로그램/체험
          { key:"program", label:"프로그램", pos:["프로그램 알차","알차","체험 다양","볼거리 많","놀거리 많","유익"], neg:["프로그램 아쉽","볼거리 적","놀거리 적","체험 적","구성이 아쉽"] },

          // 직원/응대
          { key:"staff", label:"직원 응대", pos:["친절","응대 좋","설명 잘"], neg:["불친절","응대 아쉽","설명 부족"] },

          // 예약/운영
          { key:"reservation", label:"예약", pos:["예약 편","예약 쉬"], neg:["예약 어렵","예약 힘","예약 불편"] }
        ];

        function detectAspects(text){
          const hits=[];
          for(const aspect of aspectDefs){
            let posHit=0, negHit=0;
            for(const w of aspect.pos){ if(text.includes(w.toLowerCase())) posHit++; }
            for(const w of aspect.neg){ if(text.includes(w.toLowerCase())) negHit++; }
            if(posHit || negHit){
              hits.push({
                key:aspect.key,
                label:aspect.label,
                pos:posHit,
                neg:negHit,
                tone: posHit>negHit ? "positive" : negHit>posHit ? "negative" : "mixed"
              });
            }
          }
          return hits;
        }

        function analyseItem(item){
          const text=(stripHtml(item.title)+" "+stripHtml(item.description)).toLowerCase();
          const aspects=detectAspects(text);
          const pos=aspects.reduce((s,x)=>s+x.pos,0);
          const neg=aspects.reduce((s,x)=>s+x.neg,0);

          // 장단점이 함께 있으면 "중립/혼합"으로 우선 분류
          let tone="neutral";
          if(pos>0 && neg>0) tone="neutral";
          else if(pos>0) tone="positive";
          else if(neg>0) tone="negative";

          return {item,text,aspects,tone};
        }

        const analysed=items.map(analyseItem);
        const groups={
          positive:analysed.filter(x=>x.tone==="positive"),
          neutral:analysed.filter(x=>x.tone==="neutral"),
          negative:analysed.filter(x=>x.tone==="negative")
        };

        const sampleSize=analysed.length;
        const minimumSampleSize=5;
        const enoughData=sampleSize>=minimumSampleSize;

        const pct=n=>sampleSize?Math.round(n/sampleSize*100):0;
        const positivePct=enoughData?pct(groups.positive.length):0;
        const negativePct=enoughData?pct(groups.negative.length):0;
        const neutralPct=enoughData?Math.max(0,100-positivePct-negativePct):0;

        // 감정별 실제 생활형 키워드 집계
        function aspectStats(group){
          const stats=new Map();
          for(const row of group){
            for(const a of row.aspects){
              const rec=stats.get(a.key)||{key:a.key,label:a.label,pos:0,neg:0,mixed:0,docs:0};
              rec.docs+=1;
              rec.pos+=a.pos;
              rec.neg+=a.neg;
              if(a.pos && a.neg) rec.mixed+=1;
              stats.set(a.key,rec);
            }
          }
          return [...stats.values()].sort((a,b)=>b.docs-a.docs || (b.pos+b.neg)-(a.pos+a.neg));
        }

        const stats={
          positive:aspectStats(groups.positive),
          neutral:aspectStats(groups.neutral),
          negative:aspectStats(groups.negative)
        };

        function keywordLabel(stat){
          const positiveMap={
            kidFun:"아이가 즐거워함", temperature:"시원함", clean:"깨끗함", price:"가격 합리적",
            distance:"거리 가까움", parking:"주차 편리", toilet:"화장실 편리", wait:"대기 짧음",
            crowd:"한적함", space:"공간 넓음", rest:"쉴 곳 많음", program:"프로그램 알참",
            staff:"직원 친절", reservation:"예약 편리"
          };
          const negativeMap={
            kidFun:"아이 지루함", temperature:"더움·답답함", clean:"청결 아쉬움", price:"비쌈",
            distance:"거리 멂", parking:"주차 불편", toilet:"화장실 불편", wait:"대기 김",
            crowd:"혼잡함", space:"공간 좁음", rest:"쉴 곳 부족", program:"프로그램 아쉬움",
            staff:"응대 아쉬움", reservation:"예약 불편"
          };

          if(stat.pos>stat.neg) return {label:positiveMap[stat.key]||stat.label,tone:"positive"};
          if(stat.neg>stat.pos) return {label:negativeMap[stat.key]||stat.label,tone:"negative"};
          return {label:stat.label,tone:"neutral"};
        }

        // 감정 카드에서 보여줄 "대표 언급" 문장
        function makeSummaryLines(tone){
          const group=groups[tone];
          if(!group.length){
            if(tone==="positive") return ["긍정으로 분류된 후기는 없었어요."];
            if(tone==="negative") return ["부정으로 분류된 후기는 없었어요."];
            return ["장단점이 함께 언급된 후기는 없었어요."];
          }

          const toneStats=stats[tone];
          const lines=[];

          if(tone==="neutral"){
            // 같은 글 안의 장점+단점 조합을 우선 찾기
            const pairMap=new Map();
            for(const row of group){
              const posAs=row.aspects.filter(a=>a.pos>a.neg);
              const negAs=row.aspects.filter(a=>a.neg>a.pos);
              for(const p of posAs){
                for(const n of negAs){
                  const pk=keywordLabel({...p,key:p.key,label:p.label}).label;
                  const nk=keywordLabel({...n,key:n.key,label:n.label}).label;
                  const key=`${nk}|${pk}`;
                  pairMap.set(key,(pairMap.get(key)||0)+1);
                }
              }
            }
            const pairs=[...pairMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,2);
            for(const [pair,count] of pairs){
              const [negLabel,posLabel]=pair.split("|");
              lines.push(`${negLabel}는 아쉽지만 ${posLabel}다는 반응이 ${count}건 보여요.`);
            }
          }

          if(lines.length<2){
            for(const st of toneStats.slice(0,3)){
              const k=keywordLabel(st);
              if(tone==="positive"){
                if(st.key==="kidFun") lines.push(`아이가 즐거워했다는 언급이 ${st.docs}건 보여요.`);
                else if(st.key==="parking") lines.push(`주차가 편리하다는 언급이 ${st.docs}건 보여요.`);
                else if(st.key==="toilet") lines.push(`화장실 이용이 편리하다는 언급이 ${st.docs}건 보여요.`);
                else if(st.key==="clean") lines.push(`깨끗하다는 언급이 ${st.docs}건 보여요.`);
                else if(st.key==="program") lines.push(`프로그램이 알차다는 언급이 ${st.docs}건 보여요.`);
                else if(st.key==="price") lines.push(`가격이 합리적이라는 언급이 ${st.docs}건 보여요.`);
                else if(st.key==="distance") lines.push(`가까워서 이동이 편하다는 언급이 ${st.docs}건 보여요.`);
                else if(st.key==="temperature") lines.push(`시원하고 쾌적하다는 언급이 ${st.docs}건 보여요.`);
                else lines.push(`${k.label}에 대한 긍정 언급이 ${st.docs}건 보여요.`);
              }else if(tone==="negative"){
                if(st.key==="parking") lines.push(`주차가 불편하다는 언급이 ${st.docs}건 보여요.`);
                else if(st.key==="distance") lines.push(`거리가 멀다는 언급이 ${st.docs}건 보여요.`);
                else if(st.key==="price") lines.push(`가격이 비싸다는 언급이 ${st.docs}건 보여요.`);
                else if(st.key==="temperature") lines.push(`덥거나 답답하다는 언급이 ${st.docs}건 보여요.`);
                else if(st.key==="wait") lines.push(`대기가 길다는 언급이 ${st.docs}건 보여요.`);
                else if(st.key==="crowd") lines.push(`붐비고 혼잡하다는 언급이 ${st.docs}건 보여요.`);
                else lines.push(`${k.label} 관련 아쉬움이 ${st.docs}건 보여요.`);
              }else{
                // neutral fallback: 혼합 문맥이 뚜렷하지 않을 때는 사실 그대로
                lines.push(`${k.label} 관련 언급이 ${st.docs}건 보여요.`);
              }
              if(lines.length>=2) break;
            }
          }

          if(!lines.length){
            if(tone==="positive") lines.push(`긍정으로 분류된 후기가 ${group.length}건 있지만 반복되는 생활형 포인트는 뚜렷하지 않아요.`);
            else if(tone==="negative") lines.push(`부정으로 분류된 후기가 ${group.length}건 있지만 반복되는 불편 포인트는 뚜렷하지 않아요.`);
            else lines.push(`장단점이 함께 언급된 후기가 ${group.length}건 있지만 공통 패턴은 뚜렷하지 않아요.`);
          }

          return lines.slice(0,2);
        }

        // 화면 하단 "주요 반응 키워드"
        const keywordMap=new Map();
        for(const tone of ["positive","neutral","negative"]){
          for(const st of stats[tone]){
            const k=keywordLabel(st);
            // 중립 그룹이어도 실제 단어 방향은 긍/부정으로 표시
            const id=`${k.tone}:${k.label}`;
            const rec=keywordMap.get(id)||{label:k.label,tone:k.tone,count:0};
            rec.count+=st.docs;
            keywordMap.set(id,rec);
          }
        }
        const readableKeywords=[...keywordMap.values()]
          .filter(x=>x.count>=1)
          .sort((a,b)=>b.count-a.count || a.label.localeCompare(b.label,"ko"))
          .slice(0,8);

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
          analysisVersion: "reaction-v4",
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
            minimumSampleSize,
            basis: "네이버 블로그 검색 상위 최대 20건의 제목·요약문 기준 자동 분류"
          },
          sentimentDetails: {
            positive: {
              count: groups.positive.length,
              lines: makeSummaryLines("positive")
            },
            neutral: {
              count: groups.neutral.length,
              lines: makeSummaryLines("neutral")
            },
            negative: {
              count: groups.negative.length,
              lines: makeSummaryLines("negative")
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
