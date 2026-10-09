import { describe, expect, it } from "vitest";
import { HttpStatusError } from "@nju-info/collector";
import { CollectionStageError, diagnoseCollectionError } from "./diagnostics.js";

describe("collection error diagnostics", () => {
  it("retains a nested phase and whitelisted DNS, TLS, and HTTP metadata only", () => {
    const dnsError = Object.assign(new Error("token=secret cookie=private"), {
      code: "ENOTFOUND",
    });
    const tlsError = Object.assign(new Error("certificate body secret"), {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
      cause: dnsError,
    });
    const httpError = new HttpStatusError(503);
    Object.defineProperty(httpError, "cause", { value: tlsError });
    const stageError = new CollectionStageError("detail-fetch", httpError);

    expect(stageError.cause).toBe(httpError);
    const diagnostic = diagnoseCollectionError(stageError);
    expect(diagnostic).toEqual({
      phase: "detail-fetch",
      causes: [
        { name: "CollectionStageError" },
        { name: "HttpStatusError", status: 503 },
        { name: "Error", code: "ERR_TLS_CERT_ALTNAME_INVALID" },
        { name: "Error", code: "ENOTFOUND" },
      ],
    });

    const serialized = JSON.stringify(diagnostic);
    for (const secret of ["token", "cookie", "certificate body", "secret"]) {
      expect(serialized).not.toContain(secret);
    }
  });
  it("distinguishes native deadline expiry from an underlying connection timeout without exposing endpoint text", () => {
    const deadline = new DOMException("credential=deadline-secret", "TimeoutError");
    const connection = new TypeError("fetch failed at https://private.invalid/?token=connection-secret", {
      cause: Object.assign(new Error("private socket address"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
    });
    const diagnostic = diagnoseCollectionError(new CollectionStageError("list-fetch", new AggregateError([deadline, connection])));
    expect(diagnostic.phase).toBe("list-fetch");
    expect(diagnostic.causes).toEqual(expect.arrayContaining([
      { name: "TimeoutError" }, { name: "Error", code: "UND_ERR_CONNECT_TIMEOUT" },
    ]));
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
    expect(JSON.stringify(diagnostic)).not.toContain("private");
  });


  it("normalizes non-Error values and hostile error metadata", () => {
    expect(diagnoseCollectionError("token=secret https://private.example"))
      .toEqual({ phase: "collection", causes: [{ name: "Error" }] });

    const hostile = new Error("private message");
    Object.defineProperties(hostile, {
      name: { get: () => "PrivateCredentialError" },
      code: { get: () => "/private/path" },
      status: { get: () => 600 },
      cause: { get: () => { throw new Error("secret from getter"); } },
      stack: { get: () => "private stack trace" },
    });

    const diagnostic = diagnoseCollectionError(hostile);
    expect(diagnostic).toEqual({ phase: "collection", causes: [{ name: "Error" }] });
    expect(JSON.stringify(diagnostic)).not.toContain("private");
  });

  it("bounds aggregate fanout and terminates cyclic cause graphs", () => {
    const cycle = new Error("cycle message");
    const aggregate = new AggregateError(
      [cycle, ...Array.from({ length: 1000 }, (_, index) => new Error(`secret ${index}`))],
      "aggregate message",
    );
    Object.defineProperty(cycle, "cause", { value: aggregate });

    const diagnostic = diagnoseCollectionError(
      new CollectionStageError("persistence", aggregate),
    );
    expect(diagnostic.phase).toBe("persistence");
    expect(diagnostic.causes.length).toBeLessThanOrEqual(8);
    expect(diagnostic.causes[0]).toEqual({ name: "CollectionStageError" });
    expect(diagnostic.causes[1]).toEqual({ name: "AggregateError" });
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
  });
  it("ignores nonnumeric aggregate lengths without coercing private values", () => {
    const aggregate = new AggregateError([], "private aggregate text");
    Object.defineProperty(aggregate, "errors", { value: new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") return Symbol("private length");
        return Reflect.get(target, property, receiver);
      },
    }) });
    const diagnostic = diagnoseCollectionError(new CollectionStageError("list-fetch", aggregate));
    expect(diagnostic).toEqual({
      phase: "list-fetch", causes: [{ name: "CollectionStageError" }, { name: "AggregateError" }],
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private");
  });


  it("drops arbitrary names, codes, and untyped HTTP statuses", () => {
    const unsafe = Object.assign(new Error("message must not escape"), {
      name: "ApiKeyError",
      code: "credential=/private/file",
      status: 503,
    });

    expect(diagnoseCollectionError(unsafe)).toEqual({
      phase: "collection",
      causes: [{ name: "Error" }],
    });
  });
});
