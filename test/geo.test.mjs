import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPointsFile,
  isInKorea,
  pickExactAddress,
  roadAddressKey,
  roadKeyString,
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
    assert.equal(searchKeyword("경기도 수원시 팔달구 효원로 241 [1층]"), "경기도 수원시 팔달구 효원로 241 1층");
  });

  it("도로명코드·건물번호가 같은 결과만 고른다", () => {
    const key = roadAddressKey(sejong);
    const results = [
      { rnMgtSn: "361104855627", udrtYn: "0", buldMnnm: "12", buldSlno: "0", admCd: "X" },
      { rnMgtSn: "361104855627", udrtYn: "0", buldMnnm: "10", buldSlno: "0", admCd: "3611011700" }
    ];
    assert.equal(pickExactAddress(results, key)?.admCd, "3611011700");
    assert.equal(pickExactAddress([results[0]], key), null);
  });
});

/** 검색·좌표 API 가짜 응답. 요청 URL을 기록한다. */
function fakeJuso({ searchResults = [], coord = { entX: "990000", entY: "1840000" }, searchCode = "0" } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname.endsWith("addrCoordApi.do") ? "coord" : "search");
    const results = u.pathname.endsWith("addrCoordApi.do")
      ? { common: { errorCode: "0", errorMessage: "정상" }, juso: [coord] }
      : { common: { errorCode: searchCode, errorMessage: searchCode === "0" ? "정상" : "승인되지 않은 KEY 입니다." }, juso: searchResults };
    return new Response(JSON.stringify({ results }), { status: 200 });
  };
  return { client: createJusoClient({ searchKey: "s", coordKey: "c", fetchImpl, retryDelayMs: 0 }), calls };
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
