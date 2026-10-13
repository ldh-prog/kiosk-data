import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPointsFile,
  isInKorea,
  pickSameBuilding,
  roadAddressKey,
  roadKeyString,
  roadOnlyKeyword,
  searchKeyword,
  utmkToWgs84
} from "../scripts/geo.mjs";
import { attachCoordinates, carryKey, createJusoClient, geocodeRow, previousCoordinates } from "../scripts/geocode.mjs";

// pyproj(EPSG:5179 → EPSG:4326)로 만든 기준값
const REFERENCE = [
  { name: "원점", x: 1000000.0, y: 2000000.0, lat: 38.0, lon: 127.5 },
  { name: "서울시청", x: 953896.191, y: 1952009.386, lat: 37.5662952, lon: 126.9779451 },
  { name: "제주", x: 910010.546, y: 1501279.789, lat: 33.4996, lon: 126.5312 },
  { name: "울릉도", x: 1301138.678, y: 1948256.828, lat: 37.4845, lon: 130.9057 },
  { name: "울산 동구", x: 1173822.479, y: 1724910.703, lat: 35.5049, lon: 129.4166 }
];

describe("utmkToWgs84", () => {
  for (const point of REFERENCE) {
    it(`${point.name}을 pyproj와 1e-6도 안으로 맞춘다`, () => {
      const { lat, lon } = utmkToWgs84(point.x, point.y);
      assert.ok(Math.abs(lat - point.lat) < 1e-6, `lat ${lat} vs ${point.lat}`);
      assert.ok(Math.abs(lon - point.lon) < 1e-6, `lon ${lon} vs ${point.lon}`);
    });
  }

  it("한국 밖 좌표를 거른다", () => {
    assert.equal(isInKorea(37.56, 126.97), true);
    assert.equal(isInKorea(0, 0), false);
    assert.equal(isInKorea(Number.NaN, 127), false);
  });
});

const sejong = {
  MNG_NO: "1",
  OPN_ATMY_GRP_CD: "5690000",
  CTPV_CD: "6200000",
  INSTL_PLC_ADDR: "세종특별자치시 다정남3로 10, 다정동 복합커뮤니티센터 (다정동)",
  ROAD_SGG_CD: "36110",
  ROAD_CD: "4855627",
  ROAD_BLDG_FLR_SE: "0",
  ROAD_BLDGMNO: "10",
  ROAD_BLDGSNO: ""
};

describe("도로명주소 키와 검색어", () => {
  it("설치정보에서 좌표제공 API 요청값을 만든다", () => {
    assert.deepEqual(roadAddressKey(sejong), { rnMgtSn: "361104855627", udrtYn: "0", buldMnnm: "10", buldSlno: "0" });
    assert.equal(roadKeyString(roadAddressKey(sejong)), "361104855627:0:10:0");
    assert.equal(roadAddressKey({ ...sejong, ROAD_CD: "" }), null);
  });

  it("쉼표 뒤 건물명과 괄호, 특수문자를 뺀다", () => {
    assert.equal(searchKeyword(sejong.INSTL_PLC_ADDR), "세종특별자치시 다정남3로 10");
    assert.equal(searchKeyword("서울특별시 종로구 삼봉로 43 (수송동)"), "서울특별시 종로구 삼봉로 43");
    assert.equal(searchKeyword("경기도 수원시 팔달구 효원로 241 [1층]"), "경기도 수원시 팔달구 효원로 241");
  });

  it("대괄호 안의 지번주소·건물명을 뺀다", () => {
    assert.equal(
      searchKeyword("서울특별시 강서구 화곡로 302(화곡동)[화곡동 980-16 강서구청]"),
      "서울특별시 강서구 화곡로 302"
    );
    assert.equal(
      searchKeyword("대구광역시 동구 율하동로25길 5(신기동)[대구광역시 동구 신기동 545번지 2호]"),
      "대구광역시 동구 율하동로25길 5"
    );
    assert.equal(searchKeyword("서울특별시 강북구 도봉로 지하 338(수유동)[서울특별시 강북구 수유동 140번지]"), "서울특별시 강북구 도봉로 지하 338");
  });

  it("괄호 안 쉼표와 닫히지 않은 괄호를 처리하고, 도로명의 점은 남긴다", () => {
    assert.equal(searchKeyword("인천광역시 서구 한들로 73 (백석동, 검암역로열파크씨티푸르지오2단지)"), "인천광역시 서구 한들로 73");
    assert.equal(searchKeyword("서울특별시 용산구 원효로 251 (원효로1가"), "서울특별시 용산구 원효로 251");
    assert.equal(searchKeyword("충청남도 당진시 대호지면 4.4만세로 55-1, 대호지면사무소"), "충청남도 당진시 대호지면 4.4만세로 55-1");
  });

  it("시도 + 도로명 + 건물번호만 남긴 검색어를 만든다", () => {
    assert.equal(roadOnlyKeyword("인천광역시 중구 운남서로 100"), "인천광역시 운남서로 100");
    assert.equal(roadOnlyKeyword("경기도 광주시 오포읍 양벌로215번길 7"), "경기도 양벌로215번길 7");
    assert.equal(roadOnlyKeyword("서울특별시 강북구 도봉로 지하 338"), "서울특별시 도봉로 지하 338");
    assert.equal(roadOnlyKeyword("경상남도 밀양시 밀양대로 1993-20"), "경상남도 밀양대로 1993-20");
    assert.equal(roadOnlyKeyword("세종특별자치시 다정남3로 10"), "세종특별자치시 다정남3로 10");
    assert.equal(roadOnlyKeyword("운남서로 100"), "");
    assert.equal(roadOnlyKeyword("서울특별시 종로구 세종대로"), "");
  });
});

describe("pickSameBuilding", () => {
  const key = roadAddressKey(sejong);

  it("도로명코드·건물번호가 같은 결과를 고른다", () => {
    const results = [
      { rnMgtSn: "361104855627", udrtYn: "0", buldMnnm: "12", buldSlno: "0", admCd: "X", rn: "다정남3로" },
      { rnMgtSn: "361104855627", udrtYn: "0", buldMnnm: "10", buldSlno: "0", admCd: "3611011700", rn: "다정남3로" }
    ];
    assert.equal(pickSameBuilding(results, key)?.admCd, "3611011700");
    assert.equal(pickSameBuilding([results[0]], key), null);
  });

  it("지하여부까지 같은 결과를 먼저 고르고, 지하여부만 다르면 허용한다", () => {
    const above = { rnMgtSn: "361104855627", udrtYn: "0", buldMnnm: "10", buldSlno: "0", admCd: "A" };
    const below = { ...above, udrtYn: "1", admCd: "B" };
    assert.equal(pickSameBuilding([below, above], key)?.admCd, "A");
    assert.equal(pickSameBuilding([below], key)?.admCd, "B");
  });

  // 2026 화성시 4개 구 신설: 원본 41590 + 3210169, 현재 41597(동탄구) + 3210169
  const hwaseong = roadAddressKey({ ROAD_SGG_CD: "41590", ROAD_CD: "3210169", ROAD_BLDG_FLR_SE: "0", ROAD_BLDGMNO: "195", ROAD_BLDGSNO: "" });
  const dongtan = { rnMgtSn: "415973210169", udrtYn: "0", buldMnnm: "195", buldSlno: "0", admCd: "4159710200", rn: "동탄반석로" };

  it("시군구코드만 바뀐 결과를 도로명이 검색어와 같을 때 받는다", () => {
    assert.equal(pickSameBuilding([dongtan], hwaseong, "경기도 화성시 동탄반석로 195")?.admCd, "4159710200");
    assert.equal(pickSameBuilding([dongtan], hwaseong, "경기도 화성시 다른로 195"), null);
    assert.equal(pickSameBuilding([dongtan], hwaseong), null);
  });

  it("같은 시군구에서 도로명번호만 바뀐 결과를 도로명이 검색어와 같을 때 받는다", () => {
    // 의정부 평화로: 원본 3181063, 현재 3215066
    const uijeongbu = roadAddressKey({ ROAD_SGG_CD: "41150", ROAD_CD: "3181063", ROAD_BLDG_FLR_SE: "0", ROAD_BLDGMNO: "363", ROAD_BLDGSNO: "0" });
    const renumbered = { rnMgtSn: "411503215066", udrtYn: "0", buldMnnm: "363", buldSlno: "0", admCd: "4115010200", rn: "평화로" };
    assert.equal(pickSameBuilding([renumbered], uijeongbu, "경기도 의정부시 평화로 363")?.admCd, "4115010200");
    // 시군구도 도로명번호도 다르면 같은 건물로 보지 않는다.
    assert.equal(pickSameBuilding([{ ...renumbered, rnMgtSn: "411713215066" }], uijeongbu, "경기도 의정부시 평화로 363"), null);
  });

  it("건물번호가 다르면 어느 단계에서도 받지 않는다", () => {
    assert.equal(pickSameBuilding([{ ...dongtan, buldMnnm: "196" }], hwaseong, "경기도 화성시 동탄반석로 195"), null);
    assert.equal(pickSameBuilding([{ ...dongtan, buldSlno: "1" }], hwaseong, "경기도 화성시 동탄반석로 195"), null);
  });
});

/**
 * 검색·좌표 API 가짜 응답. 요청 종류와 검색어, 좌표 요청값을 기록한다.
 * searchResults는 배열이나 (검색어) => 배열 함수다.
 * coordCodes는 좌표 API가 차례로 돌려줄 errorCode다(마지막 값을 계속 쓴다).
 */
function fakeJuso({ searchResults = [], coord = { entX: "990000", entY: "1840000" }, searchCode = "0", coordCodes = ["0"] } = {}) {
  const calls = [];
  const keywords = [];
  const coordParams = [];
  let coordCalls = 0;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const isCoord = u.pathname.endsWith("addrCoordApi.do");
    calls.push(isCoord ? "coord" : "search");
    let results;
    if (isCoord) {
      coordParams.push(Object.fromEntries(u.searchParams));
      const code = coordCodes[Math.min(coordCalls, coordCodes.length - 1)];
      coordCalls += 1;
      results = code === "0"
        ? { common: { errorCode: "0", errorMessage: "정상" }, juso: [coord] }
        : { common: { errorCode: code, errorMessage: "짦은 시간동안 다량의 주소검색 요청이 있습니다." }, juso: null };
    } else {
      const keyword = u.searchParams.get("keyword");
      keywords.push(keyword);
      const juso = typeof searchResults === "function" ? searchResults(keyword) : searchResults;
      results = { common: { errorCode: searchCode, errorMessage: searchCode === "0" ? "정상" : "승인되지 않은 KEY 입니다." }, juso };
    }
    return new Response(JSON.stringify({ results }), { status: 200 });
  };
  const client = createJusoClient({
    searchKey: "s",
    coordKey: "c",
    fetchImpl,
    retryDelayMs: 0,
    rateLimitDelayMs: 0,
    searchIntervalMs: 0,
    coordIntervalMs: 0
  });
  return { client, calls, keywords, coordParams };
}

const sejongMatch = { rnMgtSn: "361104855627", udrtYn: "0", buldMnnm: "10", buldSlno: "0", admCd: "3611011700" };

describe("geocodeRow", () => {
  it("검색 → 좌표 → WGS84", async () => {
    const { client, calls } = fakeJuso({ searchResults: [sejongMatch] });
    const result = await geocodeRow(client, sejong);
    assert.equal(result.status, "ok");
    assert.ok(isInKorea(result.lat, result.lon));
    assert.deepEqual(calls, ["search", "coord"]);
  });

  it("같은 건물이 검색되지 않으면 좌표를 부르지 않는다", async () => {
    const { client, calls } = fakeJuso({ searchResults: [{ ...sejongMatch, buldMnnm: "12" }] });
    assert.equal((await geocodeRow(client, sejong)).status, "noMatch");
    assert.deepEqual(calls, ["search"]);
  });

  // 인천 중구 → 영종구(2026-07-01). 원본은 옛 주소·옛 시군구코드 28110이다.
  const yeongjong = {
    ...sejong,
    INSTL_PLC_ADDR: "인천광역시 중구 운남서로 100(운남동)",
    ROAD_SGG_CD: "28110",
    ROAD_CD: "3149037",
    ROAD_BLDGMNO: "100"
  };
  const yeongjongMatch = { rnMgtSn: "281553149037", udrtYn: "0", buldMnnm: "100", buldSlno: "0", admCd: "2815510200", rn: "운남서로" };

  it("옛 시군구 이름으로 못 찾으면 시도 + 도로명 + 건물번호로 다시 찾고, 좌표는 현재 도로명코드로 묻는다", async () => {
    const { client, calls, keywords, coordParams } = fakeJuso({
      searchResults: (keyword) => (keyword === "인천광역시 운남서로 100" ? [yeongjongMatch] : [])
    });
    assert.equal((await geocodeRow(client, yeongjong)).status, "ok");
    assert.deepEqual(calls, ["search", "search", "coord"]);
    assert.deepEqual(keywords, ["인천광역시 중구 운남서로 100", "인천광역시 운남서로 100"]);
    assert.equal(coordParams[0].rnMgtSn, "281553149037");
    assert.equal(coordParams[0].admCd, "2815510200");
  });

  it("다시 찾아도 같은 건물이 없으면 좌표를 부르지 않는다", async () => {
    const { client, calls } = fakeJuso({ searchResults: [{ ...yeongjongMatch, buldMnnm: "101" }] });
    assert.equal((await geocodeRow(client, yeongjong)).status, "noMatch");
    assert.deepEqual(calls, ["search", "search"]);
  });

  it("E0007(요청 과다)이면 쉬었다가 다시 부른다", async () => {
    const { client, calls } = fakeJuso({ searchResults: [sejongMatch], coordCodes: ["E0007", "0"] });
    assert.equal((await geocodeRow(client, sejong)).status, "ok");
    assert.deepEqual(calls, ["search", "coord", "coord"]);
  });
});

describe("createJusoClient 호출 간격", () => {
  it("동시에 불러도 같은 API 호출 사이를 벌린다", async () => {
    const times = [];
    const fetchImpl = async () => {
      times.push(Date.now());
      return new Response(JSON.stringify({ results: { common: { errorCode: "0" }, juso: [] } }), { status: 200 });
    };
    const client = createJusoClient({ searchKey: "s", coordKey: "c", fetchImpl, coordIntervalMs: 60, searchIntervalMs: 0 });
    await Promise.all([client.coordinate({}), client.coordinate({}), client.coordinate({})]);
    assert.equal(times.length, 3);
    assert.ok(times[1] - times[0] >= 50, `간격 ${times[1] - times[0]}ms`);
    assert.ok(times[2] - times[1] >= 50, `간격 ${times[2] - times[1]}ms`);
  });
});

describe("attachCoordinates", () => {
  const rowsFor = () => [
    { ...sejong },
    { ...sejong, MNG_NO: "2" },
    { ...sejong, MNG_NO: "3", INSTL_PLC_ADDR: "세종특별자치시 한누리대로 2130 (보람동)", ROAD_CD: "4855999", ROAD_BLDGMNO: "2130" }
  ];

  it("직전 배포본 좌표를 이월하고, 같은 건물은 한 번만 찾는다", async () => {
    const rows = rowsFor();
    const previous = previousCoordinates([{ ...rows[2], GEO_LAT: 36.48, GEO_LON: 127.29 }]);
    const { client, calls } = fakeJuso({ searchResults: [sejongMatch] });
    const stats = await attachCoordinates(rows, previous, { client });
    assert.equal(stats.reused, 1);
    assert.equal(stats.geocoded, 2);
    assert.deepEqual(calls, ["search", "coord"]);
    assert.equal(rows[0].GEO_LAT, rows[1].GEO_LAT);
    assert.equal(rows[2].GEO_LAT, 36.48);
  });

  it("주소가 바뀌면 이월하지 않는다", () => {
    const moved = { ...sejong, INSTL_PLC_ADDR: "세종특별자치시 다른로 1" };
    assert.notEqual(carryKey(moved), carryKey(sejong));
  });

  it("키가 없으면 이월만 한다", async () => {
    const stats = await attachCoordinates(rowsFor(), new Map(), { client: null });
    assert.equal(stats.skipped, 3);
    assert.equal(stats.geocoded, 0);
  });

  it("승인키 오류면 바로 멈추고 나머지는 미처리로 남긴다", async () => {
    const { client, calls } = fakeJuso({ searchCode: "E0001" });
    const stats = await attachCoordinates(rowsFor(), new Map(), { client, concurrency: 1 });
    assert.match(stats.fatal, /E0001/);
    assert.equal(stats.geocoded, 0);
    assert.equal(stats.skipped, 3);
    assert.equal(calls.length, 1);
  });

  it("다시 불러도 E0007이면 좌표 없음이 아니라 rateLimited로 센다", async () => {
    const { client } = fakeJuso({ searchResults: [sejongMatch], coordCodes: ["E0007"] });
    const stats = await attachCoordinates(rowsFor(), new Map(), { client });
    assert.equal(stats.geocoded, 0);
    assert.equal(stats.failures.rateLimited, 2);
    assert.equal(stats.failures.noCoordinate, undefined);
    assert.equal(stats.fatal, undefined);
  });

  it("상한을 넘는 발급기는 다음 실행으로 미룬다", async () => {
    const { client } = fakeJuso({ searchResults: [sejongMatch] });
    const stats = await attachCoordinates(rowsFor(), new Map(), { client, maxLookups: 1 });
    assert.equal(stats.geocoded, 1);
    assert.equal(stats.skipped, 2);
  });
});

describe("buildPointsFile", () => {
  it("좌표가 있는 발급기만 시도별로 담는다", () => {
    const bySido = new Map([
      ["6200000", [{ GEO_LAT: 36.4800001, GEO_LON: 127.290009 }, { MNG_NO: "x" }]],
      ["6110000", [{ MNG_NO: "y" }]]
    ]);
    assert.deepEqual(buildPointsFile(bySido, "t", 1), { schema: 1, generatedAt: "t", sidos: { "6200000": [[36.48, 127.29001]] } });
  });
});
