import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";

// Phi Bot patch P6: with PHIBOT_SINGLE_COMPANY=true, the company service
// refuses a second company (409, code phibot_single_company). The route, the
// import and the seeds all go through this service.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("Phi Bot single company (P6)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const saved = process.env.PHIBOT_SINGLE_COMPANY;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-phibot-single-company-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(companies);
    if (saved === undefined) delete process.env.PHIBOT_SINGLE_COMPANY;
    else process.env.PHIBOT_SINGLE_COMPANY = saved;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates the first company, then refuses a second one with 409 phibot_single_company", async () => {
    process.env.PHIBOT_SINGLE_COMPANY = "true";
    const first = await companyService(db).create({ name: "Mon entreprise" });
    expect(first.name).toBe("Mon entreprise");
    await expect(companyService(db).create({ name: "Une autre" })).rejects.toMatchObject({
      status: 409,
      details: { code: "phibot_single_company" },
    });
    expect(await db.select().from(companies)).toHaveLength(1);
  });

  it("keeps several companies possible without the variable", async () => {
    delete process.env.PHIBOT_SINGLE_COMPANY;
    await companyService(db).create({ name: "Alpha" });
    await companyService(db).create({ name: "Beta" });
    expect(await db.select().from(companies)).toHaveLength(2);
  });
});
