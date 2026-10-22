// HEAD = the GET response (incl. the 402 PAYMENT-REQUIRED challenge) without a body (402 Index and other directory
// checkers probe with HEAD). Payment headers are dropped so a HEAD can never pay or trigger a paid lookup.
export function headAsGet(handler) {
  return (request, ...rest) => {
    if (request.method !== 'HEAD') return handler(request, ...rest);
    const h = new Headers(request.headers);
    for (const k of ['payment-signature', 'x-payment', 'authorization', 'x-credits-key', 'x-credit-token']) h.delete(k); // HEAD never pays or spends credits
    return Promise.resolve(handler(new Request(request.url, { method: 'GET', headers: h }), ...rest))
      .then((res) => new Response(null, { status: res.status, headers: res.headers }));
  };
}
