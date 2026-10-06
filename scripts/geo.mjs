/**
 * 발급기 좌표용 순수 함수. 네트워크는 geocode.mjs 에서만 다룬다.
 *
 * 설치정보 API에는 좌표가 없다(INSTL_PLC_PSTN은 ‘관공서’ 같은 시설 분류).
 * 대신 도로명주소 키(시군구코드+도로명번호, 지하여부, 건물본번·부번)가 모든 행에 있어,
 * 행정안전부 도로명주소 좌표제공 API로 주출입구 좌표를 붙인다. 이 좌표는 공공데이터라 저장·공개할 수 있다.
 * (카카오·브이월드 지오코딩은 약관상 결과를 저장·재배포할 수 없어 쓰지 않는다.)
 */

// EPSG:5179 (UTM-K, GRS80) 역변환 상수
const A = 6378137;
const F = 1 / 298.257222101;
const E2 = 2 * F - F * F;
const EP2 = E2 / (1 - E2);
const K0 = 0.9996;
const LAT0 = (38 * Math.PI) / 180;
const LON0 = (127.5 * Math.PI) / 180;
const FALSE_EASTING = 1_000_000;
const FALSE_NORTHING = 2_000_000;

function meridianArc(phi) {
  const e4 = E2 * E2;
  const e6 = e4 * E2;
  return A * (
    (1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi
    - ((3 * E2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi)
    + ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi)
    - ((35 * e6) / 3072) * Math.sin(6 * phi)
  );
}

/**
 * UTM-K(EPSG:5179) → WGS84 위경도. 횡메르카토르 역변환(Snyder 1987).
 * 한반도 범위에서 pyproj와 1e-6도(약 0.1m) 안으로 맞는다(test 참조).
 */
export function utmkToWgs84(x, y) {
  const e4 = E2 * E2;
  const e6 = e4 * E2;
  const m = meridianArc(LAT0) + (y - FALSE_NORTHING) / K0;
  const mu = m / (A * (1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256));
  const sqrt1e2 = Math.sqrt(1 - E2);
  const e1 = (1 - sqrt1e2) / (1 + sqrt1e2);
  const phi1 = mu
    + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu)
    + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const sin1 = Math.sin(phi1);
  const cos1 = Math.cos(phi1);
  const tan1 = Math.tan(phi1);
  const c1 = EP2 * cos1 * cos1;
  const t1 = tan1 * tan1;
  const n1 = A / Math.sqrt(1 - E2 * sin1 * sin1);
  const r1 = (A * (1 - E2)) / (1 - E2 * sin1 * sin1) ** 1.5;
  const d = (x - FALSE_EASTING) / (n1 * K0);

  const lat = phi1 - ((n1 * tan1) / r1) * (
    (d * d) / 2
    - ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d ** 4) / 24
    + ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d ** 6) / 720
  );
  const lon = LON0 + (
    d
    - ((1 + 2 * t1 + c1) * d ** 3) / 6
    + ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d ** 5) / 120
  ) / cos1;
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI };
}

/** 독도·마라도까지 들어가는 대략적인 한국 경계. 변환·매칭 오류로 바다 한가운데 찍히는 값을 거른다. */
export function isInKorea(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= 33 && lat <= 38.7 && lon >= 124 && lon <= 132;
}

function digits(value) {
  return String(value ?? "").trim();
}

/**
 * 설치정보 행의 도로명주소 키. 좌표제공 API 요청값과 같은 조각으로 이루어진다.
 * rnMgtSn = 시군구코드(5) + 도로명번호(7). 건물부번이 비어 있으면 0이다.
 */
export function roadAddressKey(row) {
  const sgg = digits(row?.ROAD_SGG_CD);
  const road = digits(row?.ROAD_CD);
  const main = digits(row?.ROAD_BLDGMNO);
  if (!/^\d{5}$/.test(sgg) || !/^\d{7}$/.test(road) || !/^\d+$/.test(main)) {
    return null;
  }
  return {
    rnMgtSn: `${sgg}${road}`,
    udrtYn: digits(row?.ROAD_BLDG_FLR_SE) === "1" ? "1" : "0",
    buldMnnm: String(Number(main)),
    buldSlno: String(Number(digits(row?.ROAD_BLDGSNO) || "0"))
  };
}

export function roadKeyString(key) {
  return key ? `${key.rnMgtSn}:${key.udrtYn}:${key.buldMnnm}:${key.buldSlno}` : "";
}

/**
 * 검색 API 키워드. ‘울산광역시 남구 돋질로92번길 28, 달동주민센터 (달동)’ → ‘울산광역시 남구 돋질로92번길 28’.
 * 검색 API는 특수문자가 있으면 오류를 내므로 한글·영숫자·공백·하이픈만 남긴다.
 */
export function searchKeyword(address) {
  return String(address ?? "")
    .split(",")[0]
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^가-힣A-Za-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 검색 결과 중 도로명코드·건물번호가 정확히 같은 주소만 고른다. 지하여부만 다르면 허용한다. */
export function pickExactAddress(results, key) {
  const same = (item) =>
    digits(item?.rnMgtSn) === key.rnMgtSn
    && String(Number(digits(item?.buldMnnm))) === key.buldMnnm
    && String(Number(digits(item?.buldSlno) || "0")) === key.buldSlno;
  return results.find((item) => same(item) && digits(item?.udrtYn) === key.udrtYn)
    ?? results.find(same)
    ?? null;
}

export function roundCoordinate(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** 앱이 ‘내 위치에서 가장 가까운 발급기의 시도’를 고를 때 쓰는 전국 좌표 목록. */
export function buildPointsFile(bySido, generatedAt, schema) {
  const sidos = {};
  for (const [sidoCode, items] of bySido) {
    const points = items
      .filter((item) => Number.isFinite(item.GEO_LAT) && Number.isFinite(item.GEO_LON))
      .map((item) => [Math.round(item.GEO_LAT * 1e5) / 1e5, Math.round(item.GEO_LON * 1e5) / 1e5]);
    if (points.length > 0) {
      sidos[sidoCode] = points;
    }
  }
  return { schema, generatedAt, sidos };
}
