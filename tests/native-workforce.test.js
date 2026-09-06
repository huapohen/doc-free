"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createNativeIM } = require("../native-im");
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "native-workforce-tests-"),
);
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
async function setup() {
  const file = path.join(temporary, crypto.randomUUID() + ".json"),
    admin = crypto.randomBytes(32).toString("hex");
  let clock = Date.parse("2026-09-06T01:00:00Z");
  const options = {
    file,
    adminToken: admin,
    now: () => clock,
    workspace: {
      handle: async () => {
        throw new Error("unexpected");
      },
    },
  };
  let im = createNativeIM(options);
  const call = (token, route, method = "GET", input = {}) => {
    const url = new URL("http://local/api/im" + route);
    return im.handle(method, url.pathname, input, token, url.searchParams);
  };
  const make = (name, kind = "human") =>
    call(admin, "/admin/principals", "POST", { name, kind });
  const owner = await make("Room owner"),
    employee = await make("Employee"),
    reviewer = await make("Reviewer", "agent"),
    peer = await make("Peer"),
    outside = await make("Outside");
  const { room } = await call(owner.token, "/rooms", "POST", {
    name: "Office team",
  });
  for (const person of [employee, reviewer, peer])
    await call(owner.token, `/rooms/${room.id}/members`, "POST", {
      principal_id: person.principal.id,
    });
  const request = (extra = {}) =>
    call(employee.token, `/rooms/${room.id}/approvals`, "POST", {
      client_id: crypto.randomUUID(),
      template_id: "general",
      title: "请审核工作申请",
      description: "Visible request",
      approver_id: reviewer.principal.id,
      ...extra,
    });
  const correction = (extra = {}) =>
    call(employee.token, `/rooms/${room.id}/attendance/corrections`, "POST", {
      client_id: crypto.randomUUID(),
      date: "2026-09-05",
      timezone: "Asia/Shanghai",
      check_in_at: "2026-09-05T01:00:00Z",
      check_out_at: "2026-09-05T09:00:00Z",
      reason: "昨日遗漏打卡，需要核对",
      approver_id: reviewer.principal.id,
      ...extra,
    });
  return {
    file,
    admin,
    call,
    owner,
    employee,
    reviewer,
    peer,
    outside,
    room,
    request,
    correction,
    advance: (ms) => {
      clock += ms;
    },
    restart: () => {
      im = createNativeIM(options);
    },
  };
}
const rejects = (value, code) => assert.rejects(value, { code });

test("private workforce events and attendance exports preserve the same current identity scope", async () => {
  const f = await setup();
  const result = await f.call(
    f.employee.token,
    `/rooms/${f.room.id}/attendance`,
    "POST",
    {
      client_id: "private-in",
      action: "check_in",
      location_note: "Sensitive workplace note",
    },
  );
  const request = (
    await f.request({
      title: "Private HR request",
      payload: { medical_note: "restricted" },
    })
  ).request;
  const employeeEvents = (await f.call(f.employee.token, "/events")).events;
  assert.ok(employeeEvents.some((entry) => entry.request_id === request.id));
  assert.ok(
    employeeEvents.some((entry) => entry.record_id === result.record.id),
  );
  const peerEvents = (await f.call(f.peer.token, "/events")).events;
  assert.ok(
    !peerEvents.some((entry) => /^(attendance|approval)\./.test(entry.type)),
  );
  const reviewerEvents = (await f.call(f.reviewer.token, "/events")).events;
  assert.ok(reviewerEvents.some((entry) => entry.request_id === request.id));
  assert.ok(
    !reviewerEvents.some((entry) => entry.record_id === result.record.id),
  );
  const exported = await f.call(f.employee.token, "/attendance/export");
  assert.match(exported, /Sensitive workplace note/);
  assert.ok(!exported.includes(request.id));
  assert.ok(
    !(await f.call(f.owner.token, "/attendance/export")).includes(
      result.record.id,
    ),
  );
  await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/members/${f.employee.principal.id}`,
    "DELETE",
  );
  assert.ok(
    !(await f.call(f.employee.token, "/attendance/export")).includes(
      result.record.id,
    ),
  );
});

test("attendance is self-bound server time with timezone and idempotency; location remains an unverified note", async () => {
  const f = await setup(),
    route = `/rooms/${f.room.id}/attendance`;
  await rejects(
    f.call(f.employee.token, route, "POST", {
      client_id: "out-first",
      action: "check_out",
    }),
    "check_in_required",
  );
  const payload = {
    client_id: "in-stable",
    action: "check_in",
    timezone: "Asia/Shanghai",
    location_note: "自报：办公室",
    principal_id: f.owner.principal.id,
    at: "1900-01-01",
  };
  const first = await f.call(f.employee.token, route, "POST", payload);
  assert.equal(first.record.principal_id, f.employee.principal.id);
  assert.equal(first.record.check_in_at, "2026-09-06T01:00:00.000Z");
  assert.equal(first.record.date, "2026-09-06");
  assert.equal(first.record.location_verification, "self_reported_note_only");
  f.advance(3600000);
  assert.equal(
    (await f.call(f.employee.token, route, "POST", payload)).duplicate,
    true,
  );
  await rejects(
    f.call(f.employee.token, route, "POST", {
      ...payload,
      action: "check_out",
    }),
    "idempotency_conflict",
  );
  await rejects(
    f.call(f.employee.token, route, "POST", {
      ...payload,
      client_id: "new-in",
    }),
    "already_checked_in",
  );
  const checkedOut = await f.call(f.employee.token, route, "POST", {
    client_id: "out-stable",
    action: "check_out",
    timezone: "Asia/Shanghai",
  });
  assert.equal(checkedOut.record.revision, 2);
  assert.equal(checkedOut.record.check_out_at, "2026-09-06T02:00:00.000Z");
  assert.equal((await f.call(f.owner.token, route)).records.length, 1);
  assert.equal(
    (await f.call(f.peer.token, route)).records.length,
    0,
    "ordinary members cannot inspect coworker attendance",
  );
  await rejects(f.call(f.outside.token, route), "not_a_member");
  const agent = await f.call(f.reviewer.token, route, "POST", {
    client_id: "agent-self",
    action: "check_in",
  });
  assert.equal(agent.record.principal_id, f.reviewer.principal.id);
  f.restart();
  assert.equal(
    (
      await f.call(
        f.employee.token,
        "/attendance?date=2026-09-06&timezone=Asia%2FShanghai",
      )
    ).records[0].revision,
    2,
  );
});

test("approvals are private to request participants/owner, self-approval forbidden and decision identity is server-bound", async () => {
  const f = await setup();
  await rejects(
    f.request({ approver_id: f.employee.principal.id }),
    "self_approval",
  );
  await rejects(
    f.request({ approver_id: f.outside.principal.id }),
    "invalid_approver",
  );
  const payload = {
    client_id: "stable-request",
    template_id: "expense",
    payload: { amount: 120, currency: "CNY" },
  };
  const first = await f.request(payload),
    request = first.request;
  assert.equal(
    (
      await f.request({
        payload: { currency: "CNY", amount: 120 },
        template_id: "expense",
        client_id: "stable-request",
      })
    ).duplicate,
    true,
    "key order does not break idempotency",
  );
  await rejects(
    f.request({ ...payload, title: "Changed" }),
    "idempotency_conflict",
  );
  await rejects(
    f.call(f.peer.token, `/approvals/${request.id}`),
    "approval_scope",
  );
  assert.equal(
    (await f.call(f.peer.token, "/approvals?inbox=all")).requests.length,
    0,
  );
  assert.equal(
    (await f.call(f.owner.token, "/approvals?inbox=all")).requests.length,
    1,
  );
  const decision = {
    client_id: "decision-once",
    base_revision: 1,
    decision: "approved",
    actor_id: f.owner.principal.id,
  };
  await rejects(
    f.call(
      f.employee.token,
      `/approvals/${request.id}/decision`,
      "POST",
      decision,
    ),
    "approver_required",
  );
  await rejects(
    f.call(
      f.owner.token,
      `/approvals/${request.id}/decision`,
      "POST",
      decision,
    ),
    "approver_required",
  );
  const approved = await f.call(
    f.reviewer.token,
    `/approvals/${request.id}/decision`,
    "POST",
    decision,
  );
  assert.equal(approved.request.status, "approved");
  assert.equal(approved.request.decided_by, f.reviewer.principal.id);
  assert.equal(
    (
      await f.call(
        f.reviewer.token,
        `/approvals/${request.id}/decision`,
        "POST",
        decision,
      )
    ).duplicate,
    true,
  );
  await rejects(
    f.call(f.reviewer.token, `/approvals/${request.id}/decision`, "POST", {
      ...decision,
      decision: "rejected",
    }),
    "idempotency_conflict",
  );
  const exported = await f.call(
    f.employee.token,
    `/approvals/${request.id}/export`,
  );
  assert.ok(exported.includes("active-approval"));
  assert.ok(exported.includes(f.reviewer.principal.id));
  await rejects(
    f.call(f.peer.token, `/approvals/${request.id}/export`),
    "approval_scope",
  );
});

test("approval deadlines, version checks, cancellation and membership are enforced at decision time", async () => {
  const f = await setup();
  const { request } = await f.request();
  await rejects(
    f.call(f.reviewer.token, `/approvals/${request.id}/decision`, "POST", {
      client_id: "stale",
      base_revision: 0,
      decision: "approved",
    }),
    "conflict",
  );
  await rejects(
    f.call(f.peer.token, `/approvals/${request.id}/cancel`, "POST", {
      client_id: "cancel",
      base_revision: 1,
    }),
    "approval_scope",
  );
  assert.equal(
    (
      await f.call(f.owner.token, `/approvals/${request.id}/cancel`, "POST", {
        client_id: "cancel",
        base_revision: 1,
      })
    ).request.status,
    "cancelled",
  );
  const pending = (await f.request()).request;
  await f.call(
    f.owner.token,
    `/rooms/${f.room.id}/members/${f.reviewer.principal.id}`,
    "DELETE",
  );
  await rejects(
    f.call(f.reviewer.token, `/approvals/${pending.id}/decision`, "POST", {
      client_id: "removed",
      base_revision: 1,
      decision: "approved",
    }),
    "not_a_member",
  );
  await f.call(f.owner.token, `/rooms/${f.room.id}/members`, "POST", {
    principal_id: f.reviewer.principal.id,
  });
  f.advance(8 * 86400000);
  assert.equal(
    (await f.call(f.employee.token, `/approvals/${pending.id}`)).request.status,
    "expired",
  );
  await rejects(
    f.call(f.reviewer.token, `/approvals/${pending.id}/decision`, "POST", {
      client_id: "late",
      base_revision: 2,
      decision: "approved",
    }),
    "approval_expired",
  );
});

test("attendance correction applies only on named approver approval and records original values and provenance", async () => {
  const f = await setup();
  const { request } = await f.correction({ client_id: "correction-once" });
  assert.equal(
    (await f.call(f.employee.token, "/attendance?date=2026-09-05")).records
      .length,
    0,
  );
  const decision = {
    client_id: "approve-correction",
    base_revision: 1,
    decision: "approved",
    comment: "核对后同意",
  };
  await f.call(
    f.reviewer.token,
    `/approvals/${request.id}/decision`,
    "POST",
    decision,
  );
  const record = (await f.call(f.employee.token, "/attendance?date=2026-09-05"))
    .records[0];
  assert.equal(record.check_in_at, "2026-09-05T01:00:00.000Z");
  assert.equal(record.revision, 1);
  assert.equal(record.audit[0].request_id, request.id);
  assert.equal(record.audit[0].actor_id, f.reviewer.principal.id);
  assert.equal(record.audit[0].previous.check_in_at, null);
  assert.equal(
    (
      await f.call(
        f.reviewer.token,
        `/approvals/${request.id}/decision`,
        "POST",
        decision,
      )
    ).duplicate,
    true,
  );
  assert.equal(
    (await f.call(f.employee.token, "/attendance?date=2026-09-05")).records[0]
      .audit.length,
    1,
  );
  await rejects(
    f.request({
      template_id: "attendance_correction",
      payload: { principal_id: f.owner.principal.id },
    }),
    "invalid_template",
  );
  await rejects(
    f.correction({
      date: "2026-09-07",
      check_in_at: "2026-09-07T01:00:00Z",
      check_out_at: null,
    }),
    "future_attendance",
  );
});

test("check-out after a correction request invalidates the captured record version instead of overwriting it", async () => {
  const f = await setup(),
    route = `/rooms/${f.room.id}/attendance`;
  const { record } = await f.call(f.employee.token, route, "POST", {
    client_id: "actual-in",
    action: "check_in",
  });
  const { request } = await f.correction({
    record_id: record.id,
    date: "2026-09-06",
    base_revision: 1,
    check_in_at: "2026-09-06T00:30:00Z",
    check_out_at: null,
  });
  f.advance(3600000);
  await f.call(f.employee.token, route, "POST", {
    client_id: "actual-out",
    action: "check_out",
  });
  await rejects(
    f.call(f.reviewer.token, `/approvals/${request.id}/decision`, "POST", {
      client_id: "no-overwrite",
      base_revision: 1,
      decision: "approved",
    }),
    "attendance_conflict",
  );
  const unchanged = (await f.call(f.employee.token, "/attendance")).records[0];
  assert.equal(unchanged.check_in_at, "2026-09-06T01:00:00.000Z");
  assert.equal(unchanged.revision, 2);
  assert.equal(
    (await f.call(f.employee.token, `/approvals/${request.id}`)).request.status,
    "pending",
  );
});

test("correction approval and attendance mutation share fault-stop durability, preserving both on restart", async () => {
  const f = await setup(),
    { request } = await f.correction();
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === f.file)
      throw Object.assign(new Error("injected"), { code: "EIO" });
    return rename(source, target);
  };
  try {
    await rejects(
      f.call(f.reviewer.token, `/approvals/${request.id}/decision`, "POST", {
        client_id: "fault",
        base_revision: 1,
        decision: "approved",
      }),
      "storage_failed",
    );
  } finally {
    fs.renameSync = rename;
  }
  await rejects(
    f.call(f.employee.token, "/attendance?date=2026-09-05"),
    "storage_failed",
  );
  f.restart();
  assert.equal(
    (await f.call(f.employee.token, "/attendance?date=2026-09-05")).records
      .length,
    0,
  );
  assert.equal(
    (await f.call(f.employee.token, `/approvals/${request.id}`)).request.status,
    "pending",
  );
});
