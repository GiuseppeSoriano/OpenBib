export const testAuth = { authenticated: false };
export async function mockRefresh() {
  if (!testAuth.authenticated) throw new Error("No test session");
  return "test-access-token";
}
