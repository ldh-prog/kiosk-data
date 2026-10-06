/**
 * 행정안전부 무인민원발급기 OpenAPI → GitHub Pages 정적 JSON.
 *
 * 앱에 인증키를 넣지 않으려고 만든 스냅샷이다. 원본도 하루 1회(T-2) 갱신이라
 * 하루 1회 받아 두면 앱이 직접 부르는 것과 정보가 같다.
 *
 * - 설치정보(약 59쪽): 매일 받는다.
 * - 제증명(약 5,100쪽): 일요일(KST) 또는 수동 실행 때만 받고, 다른 날은 직전 배포본을 그대로 옮긴다.
 *
 * 환경변수
 *   DATA_GO_KR_SERVICE_KEY  필수. 로그에 남기지 않는다.
 *   PAGES_BASE_URL          직전 배포본 주소. 제증명 이월과 건수 하한 비교에 쓴다.
 *   REFRESH_CERTIFICATES    "true"면 요일과 관계없이 제증명을 다시 받는다.
 *   CERT_MAX_PAGES          로컬 시험용. 제증명을 이 쪽수까지만 받는다. 배포용 아님.
 *   JUSO_SEARCH_KEY         도로명주소 검색 API 승인키. 좌표 키와 둘 다 있어야 새 발급기 좌표를 찾는다.
 *   JUSO_COORD_KEY          도로명주소 좌표제공 API 승인키. 없으면 직전 배포본 좌표만 이월한다.
 *   GEOCODE_MAX             한 번에 새로 찾을 발급기 수 상한(기본 제한 없음).
 *   OUT_DIR                 기본 site
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  API_BASE_URL,
  MAX_ROWS,
  SCHEMA_VERSION,
  asItemArray,
  assertPlausibleCount,
  compactCertificates,
  gatewayReasonCode,
  groupKiosksBySido,
  isCertificateRefreshDay,
  isFatalGatewayCode,
  isSuccessCode,
  kioskKey,
  localGovToSido,
  normalizeServiceKey
} from "./snapshot-lib.mjs";
import { buildPointsFile } from "./geo.mjs";
import { attachCoordinates, createJusoClient, previousCoordinates } from "./geocode.mjs";

const serviceKey = normalizeServiceKey(process.env.DATA_GO_KR_SERVICE_KEY);
const outDir = resolve(process.env.OUT_DIR || "site");
const pagesBaseUrl = (process.env.PAGES_BASE_URL || "").replace(/\/+$/, "");
const forceCertificateRefresh = process.env.REFRESH_CERTIFICATES === "true";
const certMaxPages = Number(process.env.CERT_MAX_PAGES || 0);
const concurrency = Math.max(1, Number(process.env.CONCURRENCY || 4));
const jusoSearchKey = (process.env.JUSO_SEARCH_KEY || "").trim();
const jusoCoordKey = (process.env.JUSO_COORD_KEY || "").trim();
const geocodeMax = process.env.GEOCODE_MAX ? Number(process.env.GEOCODE_MAX) : Infinity;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;

class FatalApiError extends Error {}

/**
 * 직전 배포본을 네트워크 문제로 못 읽었다. ‘없음(404)’과 달리 이번 실행을 접는다.
 * 첫 실행처럼 처리하면 제증명 전체(약 5,100회)와 좌표 전체를 다시 받게 된다.
 * (2026-10-07 03:00 맥이 배터리 다크 웨이크 중 다시 잠들어 DNS가 끊긴 일이 있었다.)
 */
class PreviousUnavailableError extends Error {}

function log(message) {
  console.log(message);
}

function warn(message) {
  console.log(`::warning::${message}`);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** 오류 설명에 요청 URL(인증키 포함)을 넣지 않는다. */
function describe(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause && typeof error.cause === "object" && "code" in error.cause ? ` (${error.cause.code})` : "";
  return `${error.name}: ${error.message}${cause}`;
}

async function fetchPage(path, pageNo) {
  const url = new URL(`${API_BASE_URL}${path}`);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("pageNo", String(pageNo));
  url.searchParams.set("numOfRows", String(MAX_ROWS));
  url.searchParams.set("returnType", "json");

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const text = await response.text();
      const reason = gatewayReasonCode(text);
      if (reason) {
        if (isFatalGatewayCode(reason)) {
          throw new FatalApiError(`${path} ${pageNo}쪽: 게이트웨이 오류 ${reason} (인증키·활용승인·일일 한도 확인)`);
        }
        throw new Error(`게이트웨이 오류 ${reason}`);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const parsed = JSON.parse(text);
      const header = parsed.response?.header;
      if (header && !isSuccessCode(header.resultCode)) {
        throw new Error(`resultCode ${header.resultCode} ${header.resultMsg ?? ""}`.trim());
      }
      const body = parsed.response?.body;
      return { items: asItemArray(body?.items), totalCount: Number(body?.totalCount ?? 0) };
    } catch (error) {
      if (error instanceof FatalApiError) {
        throw error;
      }
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
  }
  throw new Error(`${path} ${pageNo}쪽을 ${MAX_ATTEMPTS}번 시도했지만 실패했습니다: ${describe(lastError)}`);
}

/** 1쪽에서 전체 건수를 보고 나머지 쪽을 병렬로 받는다. 한 쪽이라도 실패하면 전체 실패. */
async function fetchAll(path, { maxPages = Infinity } = {}) {
  const first = await fetchPage(path, 1);
  const totalPages = Math.max(1, Math.ceil(first.totalCount / MAX_ROWS));
  const lastPage = Math.min(totalPages, maxPages);
  const pages = [first.items];
  let nextPage = 2;
  let finished = 1;
  let failed = false;

  async function worker() {
    while (!failed && nextPage <= lastPage) {
      const pageNo = nextPage;
      nextPage += 1;
      try {
        pages[pageNo - 1] = (await fetchPage(path, pageNo)).items;
      } catch (error) {
        failed = true;
        throw error;
      }
      finished += 1;
      if (finished % 500 === 0) {
        log(`  ${path} ${finished}/${lastPage}쪽`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, lastPage - 1)) }, worker));
  return { rows: pages.flat(), totalCount: first.totalCount, pages: lastPage, limited: lastPage < totalPages };
}

/** 받는 도중 원본이 바뀌면 쪽 경계에서 같은 행이 두 번 나올 수 있다. */
function dedupe(rows, keyOf) {
  const seen = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key && !seen.has(key)) {
      seen.set(key, row);
    }
  }
  return [...seen.values()];
}

function assertComplete(label, received, totalCount) {
  if (received < totalCount * 0.99) {
    throw new Error(`${label}: ${totalCount}건 중 ${received}건만 받았습니다.`);
  }
}

function writeJson(relativePath, value) {
  const file = resolve(outDir, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value), "utf8");
}

function writeText(relativePath, text) {
  const file = resolve(outDir, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

/** 직전 배포본 파일. 없으면(404) null, 네트워크·서버 오류가 이어지면 PreviousUnavailableError. */
async function fetchPrevious(relativePath) {
  if (!pagesBaseUrl) {
    return null;
  }
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${pagesBaseUrl}/${relativePath}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleep(3000 * attempt);
      }
    }
  }
  throw new PreviousUnavailableError(`직전 배포본 ${relativePath} 을 읽지 못했습니다: ${describe(lastError)}`);
}

async function loadPreviousMeta() {
  const text = await fetchPrevious("v1/meta.json");
  if (!text) {
    return null;
  }
  try {
    const meta = JSON.parse(text);
    return meta?.schema === SCHEMA_VERSION ? meta : null;
  } catch {
    return null;
  }
}

async function buildKiosks(previousMeta, generatedAt) {
  log("설치정보 받는 중");
  const result = await fetchAll("/installation_info");
  // 원본에 완전히 같은 행이 50건쯤 있다(2026-10). 건수 확인은 중복 제거 전에 한다.
  assertComplete("설치정보", result.rows.length, result.totalCount);
  const rows = dedupe(result.rows, (row) => kioskKey(row?.OPN_ATMY_GRP_CD, row?.MNG_NO));
  const geo = await buildCoordinates(rows, previousMeta, generatedAt);

  const { bySido, dropped } = groupKiosksBySido(rows);
  const count = [...bySido.values()].reduce((sum, list) => sum + list.length, 0);
  assertPlausibleCount("설치정보", count, { minimum: 1000, previous: previousMeta?.kiosks?.count });

  const sidos = {};
  for (const [sidoCode, items] of [...bySido].sort(([a], [b]) => a.localeCompare(b))) {
    writeJson(`v1/kiosks/${sidoCode}.json`, { schema: SCHEMA_VERSION, generatedAt, sidoCode, count: items.length, items });
    sidos[sidoCode] = items.length;
  }
  writeJson("v1/points.json", buildPointsFile(bySido, generatedAt, SCHEMA_VERSION));
  log(`설치정보 ${count}건 (${Object.keys(sidos).length}개 시도, 중복 ${result.rows.length - rows.length}건·버린 행 ${dropped}건 제외, API ${result.pages}회)`);
  return { rows, meta: { generatedAt, count, dropped, sidos }, geo };
}

/** 직전 배포본의 설치정보 파일들. 좌표 이월에 쓴다. */
async function loadPreviousKioskItems(previousMeta) {
  const items = [];
  for (const sidoCode of Object.keys(previousMeta?.kiosks?.sidos ?? {})) {
    const text = await fetchPrevious(`v1/kiosks/${sidoCode}.json`);
    try {
      items.push(...(JSON.parse(text ?? "null")?.items ?? []));
    } catch {
      // 형식이 깨진 시도는 좌표를 새로 찾는다. 네트워크 오류는 fetchPrevious가 실행을 접는다.
    }
  }
  return items;
}

async function buildCoordinates(rows, previousMeta, generatedAt) {
  const previous = previousCoordinates(await loadPreviousKioskItems(previousMeta));
  const client = jusoSearchKey && jusoCoordKey ? createJusoClient({ searchKey: jusoSearchKey, coordKey: jusoCoordKey }) : null;
  if (!client) {
    log("좌표: 도로명주소 API 키가 없어 직전 배포본 좌표만 이월합니다.");
  }
  const stats = await attachCoordinates(rows, previous, { client, maxLookups: geocodeMax, log });
  if (stats.fatal) {
    warn(`좌표 찾기 중단(키 확인): ${stats.fatal}`);
  }
  const withCoordinates = rows.filter((row) => Number.isFinite(row.GEO_LAT)).length;
  log(`좌표 ${withCoordinates}/${rows.length}곳 (이월 ${stats.reused}, 새로 ${stats.geocoded}, 실패 ${stats.failed}, 미처리 ${stats.skipped})`);
  return {
    source: "행정안전부 도로명주소 좌표제공 API(주출입구)",
    generatedAt,
    withCoordinates,
    ...stats
  };
}

function clearCertificates() {
  rmSync(resolve(outDir, "v1/certificates"), { recursive: true, force: true });
}

async function refreshCertificates(installationRows, previousMeta, generatedAt) {
  clearCertificates();
  log(certMaxPages > 0 ? `제증명 받는 중 (시험: ${certMaxPages}쪽까지)` : "제증명 받는 중");
  const result = await fetchAll("/certificate_info", { maxPages: certMaxPages > 0 ? certMaxPages : Infinity });
  if (!result.limited) {
    assertComplete("제증명", result.rows.length, result.totalCount);
  }
  const rows = dedupe(result.rows, (row) => String(row?.MNG_NO ?? "").trim());

  const { bySido, used, unmapped } = compactCertificates(rows, localGovToSido(installationRows));
  if (!result.limited) {
    assertPlausibleCount("제증명", used, { minimum: 100_000, previous: previousMeta?.certificates?.rows });
  }

  const sidos = {};
  for (const [sidoCode, data] of [...bySido].sort(([a], [b]) => a.localeCompare(b))) {
    writeJson(`v1/certificates/${sidoCode}.json`, { schema: SCHEMA_VERSION, generatedAt, sidoCode, ...data });
    sidos[sidoCode] = { kiosks: Object.keys(data.kiosks).length, documents: data.documents.length };
  }
  log(`제증명 ${used}행 (시도 대응 실패 ${unmapped}행, API ${result.pages}회)`);
  return { generatedAt, rows: used, unmapped, sidos, refreshed: true, partial: result.limited };
}

/** 직전 배포본을 그대로 옮긴다. 하나라도 못 받으면 예외. */
async function carryOverCertificates(previousMeta) {
  const previous = previousMeta?.certificates;
  if (!previous?.sidos || previous.partial) {
    throw new Error("이월할 직전 제증명이 없습니다.");
  }
  clearCertificates();
  for (const sidoCode of Object.keys(previous.sidos)) {
    const text = await fetchPrevious(`v1/certificates/${sidoCode}.json`);
    if (!text || JSON.parse(text)?.schema !== SCHEMA_VERSION) {
      throw new Error(`직전 제증명 ${sidoCode}.json 을 받지 못했습니다.`);
    }
    writeText(`v1/certificates/${sidoCode}.json`, text);
  }
  log(`제증명 이월 (${previous.generatedAt} 기준, ${Object.keys(previous.sidos).length}개 시도)`);
  return { ...previous, refreshed: false };
}

async function buildCertificates(installationRows, previousMeta, generatedAt) {
  const wantRefresh = forceCertificateRefresh || certMaxPages > 0 || isCertificateRefreshDay(new Date(generatedAt));
  if (!wantRefresh) {
    try {
      return await carryOverCertificates(previousMeta);
    } catch (error) {
      if (error instanceof PreviousUnavailableError) {
        throw error;
      }
      warn(`제증명 이월 실패, 새로 받습니다: ${describe(error)}`);
    }
  }
  try {
    return await refreshCertificates(installationRows, previousMeta, generatedAt);
  } catch (error) {
    if (!previousMeta?.certificates) {
      throw error;
    }
    warn(`제증명 갱신 실패, 직전 배포본을 씁니다: ${describe(error)}`);
    return carryOverCertificates(previousMeta);
  }
}

function indexHtml(meta) {
  const sidoLinks = Object.keys(meta.kiosks.sidos)
    .map((code) => `<li><a href="v1/kiosks/${code}.json">${code}</a> 설치정보 ${meta.kiosks.sidos[code]}건 · <a href="v1/certificates/${code}.json">발급 서류</a></li>`)
    .join("\n      ");
  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>무인민원발급기 데이터</title>
    <style>body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 16px;line-height:1.6}code{background:#f2f2f2;padding:0 4px}</style>
  </head>
  <body>
    <h1>무인민원발급기 데이터 스냅샷</h1>
    <p>「무인민원발급기 찾기」 앱(kr.ulsan.ldh.kiosk)이 읽는 정적 파일입니다. 하루 1회 갱신합니다.</p>
    <p>출처: 행정안전부, 공공데이터포털 <a href="https://www.data.go.kr/data/15154774/openapi.do">무인민원발급기정보 조회서비스</a>. 원본은 매일 갱신되며 2일 전 데이터까지 반영됩니다. 방문 전 현장을 확인하세요.</p>
    <p>좌표: 행정안전부 도로명주소 좌표제공 API(건물 주출입구 기준) · 좌표 있는 발급기 ${meta.geo.withCoordinates}/${meta.kiosks.count}곳 · <a href="v1/points.json">v1/points.json</a></p>
    <p>생성: <code>${meta.generatedAt}</code> · 설치정보 ${meta.kiosks.count}건 · 발급 서류 기준 <code>${meta.certificates.generatedAt}</code></p>
    <p><a href="v1/meta.json">v1/meta.json</a></p>
    <ul>
      ${sidoLinks}
    </ul>
  </body>
</html>
`;
}

async function main() {
  if (!serviceKey) {
    throw new Error("DATA_GO_KR_SERVICE_KEY 가 비어 있습니다.");
  }
  const generatedAt = new Date().toISOString();
  const previousMeta = await loadPreviousMeta();
  log(previousMeta ? `직전 배포: ${previousMeta.generatedAt}` : "직전 배포 없음 (첫 실행)");

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const kiosks = await buildKiosks(previousMeta, generatedAt);
  const certificates = await buildCertificates(kiosks.rows, previousMeta, generatedAt);

  const meta = {
    schema: SCHEMA_VERSION,
    generatedAt,
    source: "https://www.data.go.kr/data/15154774/openapi.do",
    kiosks: kiosks.meta,
    geo: kiosks.geo,
    certificates
  };
  writeJson("v1/meta.json", meta);
  writeText("index.html", indexHtml(meta));
  log(`완료: ${outDir}`);
}

main().catch((error) => {
  console.log(`::error::${describe(error)}`);
  process.exit(1);
});
