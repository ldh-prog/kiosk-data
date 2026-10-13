/**
 * 행정안전부 도로명주소 API로 발급기에 주출입구 좌표를 붙인다.
 *
 * - 좌표제공 API는 행정구역코드(admCd)가 필수인데 설치정보에는 없다.
 *   그래서 검색 API로 주소를 찾아 같은 건물(geo.mjs pickSameBuilding)의 admCd를 쓴다. 못 찾으면
 *   시도 + 도로명 + 건물번호만으로 한 번 더 찾는다(개편 전 시군구·읍면 이름이 원본 주소에 남은 경우).
 * - 직전 배포본에 같은 발급기·같은 주소의 좌표가 있으면 다시 부르지 않는다. 매일 새 발급기만 찾는다.
 * - 같은 건물(도로명주소 키)은 한 실행에서 한 번만 찾는다. 구청 한 곳에 발급기 여러 대가 흔하다.
 * - 요청이 몰리면 E0007(짧은 시간동안 다량의 주소검색 요청)을 준다. 2026-10-12 측정으로 좌표제공 API는
 *   초당 2회에서도 가끔 나고 초당 1회에서는 나지 않았다. 검색 API는 초당 5회에서 나지 않았다.
 *   그래서 API마다 호출 간격을 두고(검색 0.2초, 좌표 1초), E0007이면 쉬었다가 다시 부른다.
 *   간격 없이 동시 4개로 부른 첫 전체 실행은 5,718곳 중 4,567곳이 이 오류로 좌표를 못 받았다.
 */
import { kioskKey } from "./snapshot-lib.mjs";
import {
  isInKorea,
  pickSameBuilding,
  roadAddressKey,
  roadKeyString,
  roadOnlyKeyword,
  roundCoordinate,
  searchKeyword,
  utmkToWgs84
} from "./geo.mjs";

export const JUSO_SEARCH_URL = "https://business.juso.go.kr/addrlink/addrLinkApi.do";
export const JUSO_COORD_URL = "https://business.juso.go.kr/addrlink/addrCoordApi.do";

/** 승인되지 않은 키, 개발 승인키 기간 만료. 나머지 주소도 전부 실패하므로 바로 멈춘다. */
const FATAL_JUSO_CODES = new Set(["E0001", "E0014"]);
/** 짧은 시간에 요청이 많다. 잠시 뒤에 다시 부르면 된다. */
const RATE_LIMIT_CODE = "E0007";

export class JusoFatalError extends Error {}
export class JusoRateLimitError extends Error {}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** 호출 사이를 intervalMs 이상 벌린다. 여러 worker가 같이 쓰므로 순번을 기다리기 전에 먼저 잡는다. */
function createGate(intervalMs) {
  let nextAt = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, nextAt);
    nextAt = at + intervalMs;
    if (at > now) {
      await sleep(at - now);
    }
  };
}

export function createJusoClient({
  searchKey,
  coordKey,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  retryDelayMs = 1000,
  searchIntervalMs = 200,
  coordIntervalMs = 1000,
  rateLimitDelayMs = 5000
}) {
  const searchGate = createGate(searchIntervalMs);
  const coordGate = createGate(coordIntervalMs);

  async function call(url, params, gate) {
    const request = new URL(url);
    for (const [name, value] of Object.entries({ ...params, resultType: "json" })) {
      request.searchParams.set(name, value);
    }
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await gate();
        const response = await fetchImpl(request, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const body = await response.json();
        const common = body?.results?.common;
        const code = String(common?.errorCode ?? "");
        if (code !== "0") {
          const message = `${code} ${common?.errorMessage ?? ""}`.trim();
          if (FATAL_JUSO_CODES.has(code)) {
            throw new JusoFatalError(message);
          }
          if (code === RATE_LIMIT_CODE) {
            throw new JusoRateLimitError(message);
          }
          // 주소를 못 찾는 류의 오류는 다시 불러도 같다.
          return { results: [], error: message };
        }
        return { results: Array.isArray(body?.results?.juso) ? body.results.juso : [] };
      } catch (error) {
        if (error instanceof JusoFatalError) {
          throw error;
        }
        lastError = error;
        if (attempt < 3) {
          await sleep((error instanceof JusoRateLimitError ? rateLimitDelayMs : retryDelayMs) * attempt);
        }
      }
    }
    throw lastError;
  }

  return {
    search: (keyword) => call(JUSO_SEARCH_URL, { confmKey: searchKey, currentPage: "1", countPerPage: "20", keyword }, searchGate),
    coordinate: (params) => call(JUSO_COORD_URL, { confmKey: coordKey, ...params }, coordGate)
  };
}

/** 설치정보 한 행 → { status: "ok", lat, lon } 또는 실패 사유. */
export async function geocodeRow(client, row) {
  const key = roadAddressKey(row);
  if (!key) {
    return { status: "noRoadKey" };
  }
  const keyword = searchKeyword(row.INSTL_PLC_ADDR);
  if (!keyword) {
    return { status: "noAddress" };
  }
  let match = pickSameBuilding((await client.search(keyword)).results, key, keyword);
  const fallback = roadOnlyKeyword(keyword);
  if (!match && fallback && fallback !== keyword) {
    match = pickSameBuilding((await client.search(fallback)).results, key, fallback);
  }
  if (!match?.admCd) {
    return { status: "noMatch" };
  }
  // 행정구역 개편·도로명번호 재부여로 원본 도로명코드가 옛것일 수 있어, 좌표는 검색 결과의 현재 코드로 묻는다.
  const [coordinate] = (await client.coordinate({
    admCd: String(match.admCd),
    rnMgtSn: String(match.rnMgtSn),
    udrtYn: String(match.udrtYn ?? key.udrtYn),
    buldMnnm: key.buldMnnm,
    buldSlno: key.buldSlno
  })).results;
  const x = Number(coordinate?.entX);
  const y = Number(coordinate?.entY);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x === 0 || y === 0) {
    return { status: "noCoordinate" };
  }
  const { lat, lon } = utmkToWgs84(x, y);
  if (!isInKorea(lat, lon)) {
    return { status: "outOfKorea" };
  }
  return { status: "ok", lat: roundCoordinate(lat), lon: roundCoordinate(lon) };
}

/** 직전 배포본과 비교하는 키. 발급기가 옮겨 주소가 바뀌면 다시 찾는다. */
export function carryKey(row) {
  return `${kioskKey(row?.OPN_ATMY_GRP_CD, row?.MNG_NO)}|${String(row?.INSTL_PLC_ADDR ?? "").trim()}`;
}

/** 직전 배포본의 설치정보 항목들 → carryKey → 좌표 */
export function previousCoordinates(items) {
  const map = new Map();
  for (const item of items) {
    if (Number.isFinite(item?.GEO_LAT) && Number.isFinite(item?.GEO_LON)) {
      map.set(carryKey(item), { lat: item.GEO_LAT, lon: item.GEO_LON });
    }
  }
  return map;
}

/**
 * 설치정보 행에 GEO_LAT/GEO_LON 을 붙이고 통계를 돌려준다. 행 객체를 그대로 고친다.
 * client 가 없으면(키 미설정) 이월만 하고 새로 찾지 않는다.
 */
export async function attachCoordinates(rows, previous, { client, maxLookups = Infinity, concurrency = 4, log = () => {} }) {
  const stats = { total: rows.length, reused: 0, geocoded: 0, failed: 0, skipped: 0, failures: {} };
  const pending = [];
  for (const row of rows) {
    const known = previous.get(carryKey(row));
    if (known) {
      row.GEO_LAT = known.lat;
      row.GEO_LON = known.lon;
      stats.reused += 1;
    } else {
      pending.push(row);
    }
  }
  if (!client) {
    stats.skipped = pending.length;
    return stats;
  }

  const byBuilding = new Map();
  const lookup = (row) => {
    const building = roadKeyString(roadAddressKey(row)) || carryKey(row);
    if (!byBuilding.has(building)) {
      byBuilding.set(building, geocodeRow(client, row));
    }
    return byBuilding.get(building);
  };

  const queue = pending.slice(0, maxLookups);
  stats.skipped = pending.length - queue.length;
  let next = 0;
  let done = 0;
  let fatal = null;

  async function worker() {
    while (!fatal && next < queue.length) {
      const row = queue[next];
      next += 1;
      try {
        const result = await lookup(row);
        if (result.status === "ok") {
          row.GEO_LAT = result.lat;
          row.GEO_LON = result.lon;
          stats.geocoded += 1;
        } else {
          stats.failed += 1;
          stats.failures[result.status] = (stats.failures[result.status] ?? 0) + 1;
        }
      } catch (error) {
        if (error instanceof JusoFatalError) {
          fatal = error;
          break;
        }
        // 다시 불러도 E0007이면 좌표 없음과 구분해 센다. 다음 실행 때 다시 찾는다.
        const reason = error instanceof JusoRateLimitError ? "rateLimited" : "error";
        stats.failed += 1;
        stats.failures[reason] = (stats.failures[reason] ?? 0) + 1;
      }
      done += 1;
      if (done % 500 === 0) {
        log(`  좌표 ${done}/${queue.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, worker));
  if (fatal) {
    stats.skipped += queue.length - done;
    stats.fatal = fatal.message;
  }
  return stats;
}
