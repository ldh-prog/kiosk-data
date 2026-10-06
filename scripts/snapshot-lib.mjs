/**
 * 무인민원발급기 스냅샷의 순수 함수 모음. 네트워크는 build-snapshot.mjs 에서만 다룬다.
 *
 * 앱(kr.ulsan.ldh.kiosk)은 설치정보 원본 필드명을 그대로 읽어 toKiosk()로 매핑한다.
 * 그래서 설치정보는 필드 이름을 바꾸지 않고, 앱이 쓰는 필드만 남긴다.
 */

export const SCHEMA_VERSION = 1;
export const API_BASE_URL = "https://apis.data.go.kr/1741000/kiosk_info";
export const MAX_ROWS = 100;

/** 앱의 toKiosk()가 읽는 필드. ROAD_* 주소 코드는 쓰지 않아 뺀다. */
export const INSTALLATION_FIELDS = [
  "MNG_NO",
  "ISSUMCHN_NM",
  "MNG_INST_NM",
  "INSTL_PLC_ADDR",
  "INSTL_PLC_DTL_PSTN",
  "INSTL_PLC_PSTN",
  "WKDY_OPER_BGNG_TM",
  "WKDY_OPER_END_TM",
  "LHLDY_OPER_BGNG_TM",
  "LHLDY_OPER_END_TM",
  "OPER_HR_REF_CN",
  "USE_YN_NM",
  "PWDBS_CVN_ISSUMCHN_SHP",
  "FRBLND_KPD",
  "FRBLND_VOICE_GD",
  "FRDEAF_SCRN_GD",
  "BRL_LBL_ATCMNT",
  "EPHN_SCKT",
  "TCTL_ELCTNC_MONITOR",
  "SCRN_EXPSN_FWK",
  "WHCHR_USER_MNPLT",
  "CTPV_CD",
  "OPN_ATMY_GRP_CD",
  "INSTL_OPER_URL",
  "RG_MTTR_PRDOC_ISSU_SE",
  "FAM_REL_DEL_ISSU_SE",
  "DAT_UPDT_PNT",
  "LAST_MDFCN_PNT",
  // 원본 API 필드가 아니다. 도로명주소 좌표제공 API로 붙인 주출입구 WGS84 좌표(geocode.mjs).
  "GEO_LAT",
  "GEO_LON"
];

/** Encoding 키(%2F 등)를 넣어도 한 번만 디코딩한다. URLSearchParams 가 다시 인코딩한다. */
export function normalizeServiceKey(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed || !/%[0-9A-Fa-f]{2}/.test(trimmed)) {
    return trimmed;
  }
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

/** item 이 1건이면 객체, 여러 건이면 배열, 0건이면 빈 문자열인 data.go.kr 응답을 배열로 맞춘다. */
export function asItemArray(items) {
  if (items == null || items === "") {
    return [];
  }
  if (Array.isArray(items)) {
    return items;
  }
  if (typeof items !== "object" || items.item == null || items.item === "") {
    return [];
  }
  return Array.isArray(items.item) ? items.item : [items.item];
}

export function isSuccessCode(code) {
  const normalized = String(code ?? "").trim();
  return normalized === "00" || normalized === "0000" || normalized === "0" || normalized === "200";
}

/** 게이트웨이 XML 오류의 사유 코드. JSON 이면 null. */
export function gatewayReasonCode(body) {
  if (!String(body ?? "").trimStart().startsWith("<")) {
    return null;
  }
  return body.match(/<returnReasonCode>([^<]*)<\/returnReasonCode>/i)?.[1]?.trim() || "UNKNOWN";
}

/**
 * 재시도해도 소용없는 게이트웨이 오류. 20/30/31/32/33 인증·승인, 22 일일 한도 초과.
 */
export function isFatalGatewayCode(code) {
  return ["20", "22", "30", "31", "32", "33"].includes(String(code ?? "").trim());
}

/** 앱의 sameKioskNumber()와 같은 규칙. '0501'과 '501'을 같은 발급기로 본다. */
export function stripLeadingZeros(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  return text.replace(/^0+/, "") || "0";
}

/** 발급기 번호는 시군구마다 겹치므로 개방자치단체코드와 묶어서 찾는다. */
export function kioskKey(localGovCode, kioskNo) {
  return `${String(localGovCode ?? "").trim()}:${stripLeadingZeros(kioskNo)}`;
}

export function pickInstallationFields(row) {
  const picked = {};
  for (const field of INSTALLATION_FIELDS) {
    const value = row?.[field];
    if (value == null) {
      continue;
    }
    const normalized = typeof value === "string" ? value.trim() : value;
    if (normalized === "") {
      continue;
    }
    picked[field] = normalized;
  }
  return picked;
}

/** 시도코드별로 설치정보를 나눈다. 관리번호나 시도코드가 없는 행은 앱에서 찾을 수 없어 버린다. */
export function groupKiosksBySido(rows) {
  const bySido = new Map();
  let dropped = 0;
  for (const row of rows) {
    const picked = pickInstallationFields(row);
    const sido = String(picked.CTPV_CD ?? "").trim();
    if (!picked.MNG_NO || !sido) {
      dropped += 1;
      continue;
    }
    if (!bySido.has(sido)) {
      bySido.set(sido, []);
    }
    bySido.get(sido).push(picked);
  }
  for (const list of bySido.values()) {
    list.sort((a, b) => kioskKey(a.OPN_ATMY_GRP_CD, a.MNG_NO).localeCompare(kioskKey(b.OPN_ATMY_GRP_CD, b.MNG_NO)));
  }
  return { bySido, dropped };
}

/** 제증명 행에는 시도코드가 없어 설치정보의 개방자치단체코드 → 시도코드 대응을 쓴다. */
export function localGovToSido(installationRows) {
  const map = new Map();
  for (const row of installationRows) {
    const gov = String(row?.OPN_ATMY_GRP_CD ?? "").trim();
    const sido = String(row?.CTPV_CD ?? "").trim();
    if (gov && sido && !map.has(gov)) {
      map.set(gov, sido);
    }
  }
  return map;
}

/**
 * 제증명 50만 행을 시도별 사전 + 발급기별 번호 목록으로 줄인다.
 * documents[i] = [민원사무분류번호, 서류명, 메뉴명], kiosks[key].docs = 오름차순 i 목록.
 */
export function compactCertificates(certificateRows, govToSido) {
  const states = new Map();
  let unmapped = 0;
  let used = 0;
  for (const row of certificateRows) {
    const gov = String(row?.OPN_ATMY_GRP_CD ?? "").trim();
    const kioskNo = stripLeadingZeros(row?.ISSUMCHN_NO);
    const sido = govToSido.get(gov);
    if (!sido || !kioskNo) {
      unmapped += 1;
      continue;
    }
    let state = states.get(sido);
    if (!state) {
      state = { documents: [], documentIndex: new Map(), kiosks: new Map() };
      states.set(sido, state);
    }
    const tuple = [
      String(row.CVLCPT_OFCWORK_CLSF_NO ?? "").trim(),
      String(row.CVLCPT_OFCWORK_CLSF_NM ?? "").trim(),
      String(row.INITA_MENU_NM ?? "").trim()
    ];
    if (!tuple[1]) {
      unmapped += 1;
      continue;
    }
    const docKey = tuple.join("\u0000");
    let index = state.documentIndex.get(docKey);
    if (index === undefined) {
      index = state.documents.length;
      state.documents.push(tuple);
      state.documentIndex.set(docKey, index);
    }
    const key = kioskKey(gov, kioskNo);
    let kiosk = state.kiosks.get(key);
    if (!kiosk) {
      kiosk = { district: String(row.SGG_NM ?? "").trim(), docs: new Set() };
      state.kiosks.set(key, kiosk);
    }
    kiosk.docs.add(index);
    used += 1;
  }

  const bySido = new Map();
  for (const [sido, state] of states) {
    const kiosks = {};
    for (const key of [...state.kiosks.keys()].sort()) {
      const kiosk = state.kiosks.get(key);
      kiosks[key] = { district: kiosk.district, docs: [...kiosk.docs].sort((a, b) => a - b) };
    }
    bySido.set(sido, { documents: state.documents, kiosks });
  }
  return { bySido, used, unmapped };
}

/**
 * 반쯤 받은 데이터를 배포하지 않기 위한 하한선. 직전 배포의 90% 미만이면 실패로 본다.
 */
export function assertPlausibleCount(label, count, { minimum, previous } = {}) {
  if (minimum != null && count < minimum) {
    throw new Error(`${label} ${count}건은 하한 ${minimum}건보다 적습니다.`);
  }
  if (previous != null && previous > 0 && count < previous * 0.9) {
    throw new Error(`${label} ${count}건은 직전 배포 ${previous}건의 90% 미만입니다.`);
  }
}

/** 03:00 KST 실행 기준으로 일요일이면 서류 목록을 다시 받는다. */
export function isCertificateRefreshDay(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.getUTCDay() === 0;
}
