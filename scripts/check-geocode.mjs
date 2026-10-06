/**
 * 도로명주소 API 키를 넣은 뒤 전체 실행 전에 몇 곳만 좌표를 찾아 눈으로 확인한다. 배포하지 않는다.
 * 배포본에는 도로명주소 키(ROAD_*)가 없어서, 설치정보 원본을 공공데이터 API로 한 쪽만 받는다(1회).
 *
 *   DATA_GO_KR_SERVICE_KEY=... JUSO_SEARCH_KEY=... JUSO_COORD_KEY=... node scripts/check-geocode.mjs [시도코드=6310000] [개수=5]
 *
 * 출력의 카카오맵 링크를 열어 발급기 건물 입구에 핀이 찍히는지 본다.
 */
import { createJusoClient, geocodeRow } from "./geocode.mjs";
import { API_BASE_URL, asItemArray, normalizeServiceKey } from "./snapshot-lib.mjs";

const [sidoCode = "6310000", countText = "5"] = process.argv.slice(2);
const count = Math.min(100, Math.max(1, Number(countText)));
const serviceKey = normalizeServiceKey(process.env.DATA_GO_KR_SERVICE_KEY);
const searchKey = (process.env.JUSO_SEARCH_KEY || "").trim();
const coordKey = (process.env.JUSO_COORD_KEY || "").trim();
if (!serviceKey || !searchKey || !coordKey) {
  console.error("DATA_GO_KR_SERVICE_KEY, JUSO_SEARCH_KEY, JUSO_COORD_KEY 가 필요합니다.");
  process.exit(1);
}

const url = new URL(`${API_BASE_URL}/installation_info`);
url.searchParams.set("serviceKey", serviceKey);
url.searchParams.set("pageNo", "1");
url.searchParams.set("numOfRows", String(count));
url.searchParams.set("returnType", "json");
url.searchParams.set("cond[CTPV_CD::EQ]", sidoCode);
const body = await (await fetch(url)).json();
const rows = asItemArray(body?.response?.body?.items);

const client = createJusoClient({ searchKey, coordKey });
let ok = 0;
for (const row of rows) {
  let result;
  try {
    result = await geocodeRow(client, row);
  } catch (error) {
    console.error(`도로명주소 API 오류: ${error.message} (승인키·API 종류를 확인하세요)`);
    process.exit(1);
  }
  if (result.status === "ok") {
    ok += 1;
    console.log(`OK  ${row.ISSUMCHN_NM} | ${row.INSTL_PLC_ADDR}\n    ${result.lat}, ${result.lon}  https://map.kakao.com/link/map/${encodeURIComponent(row.ISSUMCHN_NM)},${result.lat},${result.lon}`);
  } else {
    console.log(`--  ${row.ISSUMCHN_NM} | ${row.INSTL_PLC_ADDR} → ${result.status}`);
  }
}
console.log(`${ok}/${rows.length}곳 좌표 찾음`);
