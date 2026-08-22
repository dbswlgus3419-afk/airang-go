export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =====================================================
    // 1. API 기본 테스트
    // =====================================================
    if (
      url.pathname === "/api/test" ||
      url.pathname === "/api/test/"
    ) {
      return Response.json({
        ok: true,
        message: "아이랑 어디갈까 API 정상 작동!",
        time: new Date().toISOString()
      });
    }

    // =====================================================
    // 공통: 나들이랩 HTML 가져오기
    // =====================================================
    async function getNadrilabHtml() {
      const response = await fetch(
        "https://www.nadrilab.com/recommend",
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
              "AppleWebKit/537.36 Chrome/120 Safari/537.36",
            "Accept":
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8"
          }
        }
      );

      if (!response.ok) {
        throw new Error(
          "나들이랩 요청 실패: " + response.status
        );
      }

      return await response.text();
    }

    // =====================================================
    // HTML 문자 정리
    // =====================================================
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

    // =====================================================
    // 특정 SNS 제목의 "실제 표시 영역" 찾기
    // =====================================================
    function findRealMarker(html, word, startAt = 0) {
      let pos = startAt;

      while (true) {
        pos = html.indexOf(word, pos);

        if (pos === -1) {
          return -1;
        }

        // 이 지점 뒤에 실제 장소 링크가 있으면
        // 화면에 표시되는 SNS 영역으로 판단
        const nearby = html.slice(
          pos,
          pos + 30000
        );

        if (
          nearby.includes('/places/') ||
          nearby.includes('href="/places/')
        ) {
          return pos;
        }

        pos += word.length;
      }
    }

    // =====================================================
    // SNS 한 구간에서 장소 링크 추출
    // =====================================================
    function extractPlaceLinks(block) {
      const results = [];
      const seen = new Set();

      // href="/places/..." 인 링크만 추출
      const regex =
        /<a\b[^>]*href=["']([^"']*\/places\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

      let match;

      while ((match = regex.exec(block)) !== null) {
        const href = match[1];
        let name = cleanText(match[2]);

        // 카드 앞쪽 순위 숫자 제거
        // 예: "1바운스 유니버스 부산" → "바운스 유니버스 부산"
        name = name.replace(/^\s*\d+\s*/, "");

        // 너무 짧거나 이상한 항목 제외
        if (!name || name.length < 2) {
          continue;
        }

        if (seen.has(name)) {
          continue;
        }

        seen.add(name);

        results.push({
          name,
          url: href.startsWith("http")
            ? href
            : "https://www.nadrilab.com" + href
        });

        // SNS별 최대 6곳
        if (results.length >= 6) {
          break;
        }
      }

      return results;
    }

    // =====================================================
    // 전체 SNS 데이터 추출
    // =====================================================
    function parseSnsHot(html) {
      const instagramStart = findRealMarker(
        html,
        "인스타그램"
      );

      const youtubeStart = findRealMarker(
        html,
        "유튜브",
        instagramStart >= 0
          ? instagramStart + 1
          : 0
      );

      const shortsStart = findRealMarker(
        html,
        "쇼츠",
        youtubeStart >= 0
          ? youtubeStart + 1
          : 0
      );

      let categoryStart = -1;

      if (shortsStart >= 0) {
        categoryStart = html.indexOf(
          "카테고리로 고르기",
          shortsStart
        );
      }

      const instagramBlock =
        instagramStart >= 0
          ? html.slice(
              instagramStart,
              youtubeStart > instagramStart
                ? youtubeStart
                : instagramStart + 50000
            )
          : "";

      const youtubeBlock =
        youtubeStart >= 0
          ? html.slice(
              youtubeStart,
              shortsStart > youtubeStart
                ? shortsStart
                : youtubeStart + 50000
            )
          : "";

      const shortsBlock =
        shortsStart >= 0
          ? html.slice(
              shortsStart,
              categoryStart > shortsStart
                ? categoryStart
                : shortsStart + 50000
            )
          : "";

      return {
        instagram: extractPlaceLinks(
          instagramBlock
        ),
        youtube: extractPlaceLinks(
          youtubeBlock
        ),
        shorts: extractPlaceLinks(
          shortsBlock
        )
      };
    }

    // =====================================================
    // 2. SNS 디버그
    // =====================================================
    if (
      url.pathname === "/api/sns-debug" ||
      url.pathname === "/api/sns-debug/"
    ) {
      try {
        const html = await getNadrilabHtml();

        const result = parseSnsHot(html);

        return Response.json({
          ok: true,
          length: html.length,
          instagramCount:
            result.instagram.length,
          youtubeCount:
            result.youtube.length,
          shortsCount:
            result.shorts.length,
          result
        });

      } catch (error) {
        return Response.json(
          {
            ok: false,
            error: error.message
          },
          { status: 500 }
        );
      }
    }

    // =====================================================
    // 3. 실제 SNS 핫플 API
    // =====================================================
    if (
      url.pathname === "/api/sns-hot" ||
      url.pathname === "/api/sns-hot/"
    ) {
      try {
        const html = await getNadrilabHtml();

        const result = parseSnsHot(html);

        return Response.json({
          ok: true,
          source: "nadrilab",
          fetchedAt:
            new Date().toISOString(),

          instagram: result.instagram,
          youtube: result.youtube,
          shorts: result.shorts
        });

      } catch (error) {
        return Response.json(
          {
            ok: false,
            error: error.message
          },
          { status: 500 }
        );
      }
    }

    // =====================================================
    // 4. 나머지 요청 = 기존 사이트
    // =====================================================
    return env.ASSETS.fetch(request);
  }
};
