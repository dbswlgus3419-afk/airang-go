export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =====================================================
    // 1. API 기본 작동 테스트
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
    // 2. 나들이랩 원본 데이터 디버그 테스트
    // =====================================================
    if (
      url.pathname === "/api/sns-debug" ||
      url.pathname === "/api/sns-debug/"
    ) {
      try {
        const response = await fetch(
          "https://www.nadrilab.com/recommend",
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
              "Accept":
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8"
            }
          }
        );

        const html = await response.text();

        return Response.json({
          ok: true,
          status: response.status,
          finalUrl: response.url,
          contentType: response.headers.get("content-type"),
          length: html.length,

          hasInstagram: html.includes("인스타그램"),
          hasYoutube: html.includes("유튜브"),
          hasShorts: html.includes("쇼츠"),

          hasSeoulChildren:
            html.includes("서울어린이대공원"),

          preview: html.slice(0, 3000)
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
    // 3. SNS 핫플 데이터 가져오기
    // =====================================================
    if (
      url.pathname === "/api/sns-hot" ||
      url.pathname === "/api/sns-hot/"
    ) {
      try {
        const response = await fetch(
          "https://www.nadrilab.com/recommend",
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
              "Accept":
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8"
            }
          }
        );

        if (!response.ok) {
          return Response.json(
            {
              ok: false,
              error:
                "나들이랩 요청 실패: " +
                response.status
            },
            {
              status: 502
            }
          );
        }

        const html = await response.text();

        // HTML을 검색하기 쉬운 텍스트로 변환
        const text = html
          .replace(
            /<script[\s\S]*?<\/script>/gi,
            " "
          )
          .replace(
            /<style[\s\S]*?<\/style>/gi,
            " "
          )
          .replace(/<[^>]+>/g, "\n")
          .replace(/&amp;/g, "&")
          .replace(/&nbsp;/g, " ")
          .replace(/&#x27;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/\r/g, "")
          .replace(/\n+/g, "\n");


        // -------------------------------------------------
        // SNS별 영역 추출
        // -------------------------------------------------
        function extractSection(startWord, endWord) {

          const start = text.indexOf(startWord);

          if (start === -1) {
            return [];
          }

          const end = text.indexOf(
            endWord,
            start + startWord.length
          );

          const block =
            end === -1
              ? text.slice(start)
              : text.slice(start, end);

          const lines = block
            .split("\n")
            .map(function (value) {
              return value.trim();
            })
            .filter(Boolean);


          const ignoreWords = [
            "인스타그램",
            "유튜브",
            "쇼츠",
            "인스타그램 6",
            "유튜브 6",
            "쇼츠 6",
            "6"
          ];


          return lines
            .filter(function (value) {

              if (ignoreWords.includes(value)) {
                return false;
              }

              if (/^\d+$/.test(value)) {
                return false;
              }

              if (value.length <= 1) {
                return false;
              }

              return true;
            })
            .slice(0, 6);
        }


        const instagram = extractSection(
          "인스타그램",
          "유튜브"
        );

        const youtube = extractSection(
          "유튜브",
          "쇼츠"
        );

        const shorts = extractSection(
          "쇼츠",
          "카테고리로 고르기"
        );


        return Response.json({
          ok: true,
          source: "nadrilab",
          fetchedAt: new Date().toISOString(),

          instagram: instagram,
          youtube: youtube,
          shorts: shorts
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
    // 4. API 주소가 아니면 기존 사이트 표시
    // =====================================================
    return env.ASSETS.fetch(request);
  }
};
