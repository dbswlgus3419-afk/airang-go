export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API 테스트
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

    // 나머지는 기존 사이트 제공
    return env.ASSETS.fetch(request);
  }
};
