export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1) 기존 API 테스트
    if (url.pathname === "/api/test" || url.pathname === "/api/test/") {
      return Response.json({
        ok: true,
        message: "아이랑 어디갈까 API 정상 작동!",
        time: new Date().toISOString()
      });
    }

    // 2) 나들이랩 SNS 핫플 가져오기
    if (url.pathname === "/api/sns-hot" || url.pathname === "/api/sns-hot/") {
      try {
        const response = await fetch(
          "https://www.nadrilab.com/recommend",
          {
            headers: {
              "User-Agent": "Mozilla/5.0",
              "Accept": "text/html"
            }
          }
        );

        if (!response.ok) {
          return Response.json(
            {
              ok: false,
              error: `나들이랩 요청 실패: ${response.status}`
            },
            { status: 502 }
          );
        }

        const html = await response.text();

        // HTML → 텍스트로 간단 변환
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, "\n")
          .replace(/&amp;/g, "&")
          .replace(/&nbsp;/g, " ")
          .replace(/&#x27;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/\n+/g, "\n");

        function extractSection(startWord, endWord) {
          const start = text.indexOf(startWord);
          if (start === -1) return [];

          const end = text.indexOf(endWord, start + startWord.length);
          const block =
            end === -1
              ? text.slice(start)
              : text.slice(start, end);

          const lines = block
            .split("\n")
            .map(v => v.trim())
            .filter(Boolean);

          const ignore = [
            startWord,
            "6",
            "인스타그램 6",
            "유튜브 6",
            "쇼츠 6"
          ];

          return lines
            .filter(v => !ignore.includes(v))
            .filter(v => !/^\d+$/.test(v))
            .filter(v => v.length > 1)
            .slice(0, 6);
        }

        const instagram = extractSection("인스타그램 6", "유튜브 6");
        const youtube = extractSection("유튜브 6", "쇼츠 6");
        const shorts = extractSection("쇼츠 6", "카테고리로 고르기");

        return Response.json({
          ok: true,
          source: "nadrilab",
          fetchedAt: new Date().toISOString(),
          instagram,
          youtube,
          shorts
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

    // 나머지는 기존 사이트
    return env.ASSETS.fetch(request);
  }
};
