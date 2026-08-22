export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =====================================================
    // 1. API 테스트
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
    // 나들이랩 HTML 가져오기
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
            "Accept-Language":
              "ko-KR,ko;q=0.9,en;q=0.8"
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
    // HTML → 텍스트 정리
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
    // SNS 핫플 18곳 추출
    // =====================================================
    function parseSnsHot(html) {

      // SNS 영역 시작점
      // 설명문에 인스타/유튜브가 있어도
      // 그 뒤의 첫 18개 장소 링크만 쓰므로 문제 없음
      let start = html.indexOf("인스타그램");

      if (start === -1) {
        start = html.indexOf("오늘의 SNS 핫플");
      }

      if (start === -1) {
        start = 0;
      }

      const snsHtml = html.slice(start);

      const regex =
        /<a\b[^>]*href=["']([^"']*\/places\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

      const places = [];
      const seen = new Set();

      let match;

      while ((match = regex.exec(snsHtml)) !== null) {

        let name = cleanText(match[2]);

        const href = match[1];

        // 앞에 붙은 순위 숫자 제거
        name = name.replace(/^\s*\d+\s*/, "");

        if (!name || name.length < 2) {
          continue;
        }

        // 중복 장소 제거
        if (seen.has(name)) {
          continue;
        }

        seen.add(name);

        places.push({
          name: name,
          url: href.startsWith("http")
            ? href
            : "https://www.nadrilab.com" + href
        });

        // SNS는 6 × 3 = 18곳
        if (places.length >= 18) {
          break;
        }
      }

      return {
        instagram: places.slice(0, 6),
        youtube: places.slice(6, 12),
        shorts: places.slice(12, 18)
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
          htmlLength: html.length,

          instagramCount:
            result.instagram.length,

          youtubeCount:
            result.youtube.length,

          shortsCount:
            result.shorts.length,

          result: result
        });

      } catch (error) {

        return Response.json(
          {
            ok: false,
            error: error.message
          },
          {
            status: 500
          }
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

          instagram:
            result.instagram.map(
              place => place.name
            ),

          youtube:
            result.youtube.map(
              place => place.name
            ),

          shorts:
            result.shorts.map(
              place => place.name
            )
        });

      } catch (error) {

        return Response.json(
          {
            ok: false,
            error: error.message
          },
          {
            status: 500
          }
        );
      }
    }

    // =====================================================
    // 4. 그 외 주소 = 기존 사이트
    // =====================================================
    return env.ASSETS.fetch(request);
  }
};
