import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

// Phi Bot patch P4: PHIBOT_DISABLE_BROWSER_CLAIM=true closes the browser
// first-admin claim; the bootstrap invite used by `phibot setup` keeps working.
const claimFirstInstanceAdminMock = vi.hoisted(() => vi.fn());

vi.mock("../first-admin-claim.js", () => ({
  claimFirstInstanceAdmin: claimFirstInstanceAdminMock,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    isInstanceAdmin: vi.fn(),
    canUser: vi.fn(),
    hasPermission: vi.fn(),
    ensureMembership: vi.fn(),
    setPrincipalGrants: vi.fn(),
  }),
  agentService: () => ({ getById: vi.fn() }),
  boardAuthService: () => ({
    createCliAuthChallenge: vi.fn(),
    resolveBoardAccess: vi.fn(),
    assertCurrentBoardKey: vi.fn(),
    revokeBoardApiKey: vi.fn(),
  }),
  deduplicateAgentName: vi.fn(),
  logActivity: vi.fn(),
  notifyHireApproved: vi.fn(),
}));

const BOOTSTRAP_TOKEN = "pcp_bootstrap_test";

function createDb(invite?: Record<string, unknown>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(invite ? [invite] : [])),
      })),
    })),
  } as any;
}

function bootstrapInvite() {
  return {
    id: "invite-1",
    companyId: null,
    inviteType: "bootstrap_ceo",
    allowedJoinTypes: "human",
    tokenHash: createHash("sha256").update(BOOTSTRAP_TOKEN).digest("hex"),
    defaultsPayload: {},
    expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    invitedByUserId: null,
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createApp(db = createDb()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", source: "session", userId: "user-1" };
    next();
  });
  app.use(
    "/api",
    accessRoutes(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("Phi Bot browser first-admin claim (P4)", () => {
  const saved = process.env.PHIBOT_DISABLE_BROWSER_CLAIM;

  beforeEach(() => {
    vi.clearAllMocks();
    claimFirstInstanceAdminMock.mockResolvedValue({ status: "claimed", userId: "user-1", value: null });
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.PHIBOT_DISABLE_BROWSER_CLAIM;
    else process.env.PHIBOT_DISABLE_BROWSER_CLAIM = saved;
  });

  it("answers 404 in authenticated private mode when PHIBOT_DISABLE_BROWSER_CLAIM is true", async () => {
    process.env.PHIBOT_DISABLE_BROWSER_CLAIM = "true";
    const res = await request(createApp()).post("/api/bootstrap/claim").send({});
    expect(res.status).toBe(404);
    expect(claimFirstInstanceAdminMock).not.toHaveBeenCalled();
  });

  it("keeps the upstream browser claim when the variable is not true", async () => {
    delete process.env.PHIBOT_DISABLE_BROWSER_CLAIM;
    const res = await request(createApp()).post("/api/bootstrap/claim").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claimed: true, userId: "user-1" });
  });

  it("still accepts the bootstrap CEO invite when the browser claim is closed", async () => {
    process.env.PHIBOT_DISABLE_BROWSER_CLAIM = "true";
    const invite = bootstrapInvite();
    claimFirstInstanceAdminMock.mockResolvedValueOnce({
      status: "claimed",
      userId: "user-1",
      value: { ...invite, acceptedAt: new Date() },
    });
    const res = await request(createApp(createDb(invite)))
      .post(`/api/invites/${BOOTSTRAP_TOKEN}/accept`)
      .send({ requestType: "human" });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ inviteType: "bootstrap_ceo", bootstrapAccepted: true, userId: "user-1" });
  });
});
