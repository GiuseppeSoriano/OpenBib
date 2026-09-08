import axios from "axios";
import { describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { changeSession } from "../session";

describe("in-memory sessions", () => {
  it("collapses concurrent refreshes and never persists a token", async () => {
    const auth = await vi.importActual<typeof import("../api")>("../api");
    let resolve!: (value: { data: { access_token: string } }) => void;
    const spy = vi.spyOn(axios, "post").mockImplementation(() => new Promise((done) => { resolve = done; }));
    const first = auth.refreshAccessToken();
    const second = auth.refreshAccessToken();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    resolve({ data: { access_token: "memory-only" } });
    expect(await first).toBe("memory-only");
    expect(await second).toBe("memory-only");
    expect(localStorage.getItem("access_token")).toBeNull();
    expect(sessionStorage.getItem("refresh_token")).toBeNull();
    auth.setAccessToken(null);
    spy.mockRestore();
  });

  it("does not resurrect an access token after local logout", async () => {
    const auth = await vi.importActual<typeof import("../api")>("../api");
    let resolve!: (value: { data: { access_token: string } }) => void;
    const spy = vi.spyOn(axios, "post").mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = auth.refreshAccessToken();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    auth.setAccessToken(null);
    resolve({ data: { access_token: "stale" } });
    await expect(pending).rejects.toThrow("Session changed");
    spy.mockRestore();
  });

  it("rejects a late refresh after a new token has been installed", async () => {
    const auth = await vi.importActual<typeof import("../api")>("../api");
    let resolve!: (value: { data: { access_token: string } }) => void;
    const spy = vi.spyOn(axios, "post").mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = auth.refreshAccessToken();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    auth.setAccessToken("new-account");
    resolve({ data: { access_token: "previous-account" } });
    await expect(pending).rejects.toThrow("Session changed");
    const response = await auth.default.get("/probe", { adapter: async config => ({ config, data: config.headers.Authorization, status: 200, statusText: "OK", headers: {} }) });
    expect(response.data).toBe("Bearer new-account");
    spy.mockRestore();
    auth.setAccessToken(null);
  });

  it("waits for the old cookie response before sending a new login", async () => {
    const auth = await vi.importActual<typeof import("../api")>("../api");
    let resolve!: (value: { data: { access_token: string } }) => void;
    const spy = vi.spyOn(axios, "post").mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValueOnce({ data: { access_token: "new-account" } });
    const refresh = auth.refreshAccessToken();
    const staleRefresh = expect(refresh).rejects.toThrow("Session changed");
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const login = changeSession(() => axios.post("/api/v1/auth/login"), ({ data }) => auth.setAccessToken(data.access_token));
    expect(spy).toHaveBeenCalledTimes(1);
    resolve({ data: { access_token: "old-account" } });
    await staleRefresh;
    await login;
    expect(spy).toHaveBeenCalledTimes(2);
    const response = await auth.default.get("/probe", { adapter: async config => ({ config, data: config.headers.Authorization, status: 200, statusText: "OK", headers: {} }) });
    expect(response.data).toBe("Bearer new-account");
    spy.mockRestore();
    auth.setAccessToken(null);
  });

  it.each([200, 401])("discards an old account response (%s) without retrying under the new account", async status => {
    const auth = await vi.importActual<typeof import("../api")>("../api");
    const spy = vi.spyOn(axios, "post");
    let finish!: () => void;
    auth.setAccessToken("old-account");
    const request = auth.default.get("/private-data", { adapter: config => new Promise((resolve, reject) => {
      finish = () => status === 200 ? resolve({ config, data: "old private data", status, statusText: "OK", headers: {} }) : reject({ config, response: { status } });
    }) });
    await waitFor(() => expect(finish).toBeDefined());
    auth.setAccessToken("new-account");
    finish();
    await expect(request).rejects.toThrow("Session changed");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    auth.setAccessToken(null);
  });
});
