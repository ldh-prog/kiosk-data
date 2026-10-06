import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  asItemArray,
  assertPlausibleCount,
  compactCertificates,
  gatewayReasonCode,
  groupKiosksBySido,
  isCertificateRefreshDay,
  isFatalGatewayCode,
  kioskKey,
  localGovToSido,
  normalizeServiceKey,
  pickInstallationFields
} from "../scripts/snapshot-lib.mjs";

describe("normalizeServiceKey", () => {
  it("Encoding 키를 한 번만 디코딩한다", () => {
    assert.equal(normalizeServiceKey(" abc%2Fdef%3D%3D "), "abc/def==");
    assert.equal(normalizeServiceKey("abc/def=="), "abc/def==");
    assert.equal(normalizeServiceKey(undefined), "");
  });
});

describe("asItemArray", () => {
  it("단건 객체, 배열, 빈 문자열을 모두 배열로 맞춘다", () => {
    assert.deepEqual(asItemArray({ item: { a: 1 } }), [{ a: 1 }]);
    assert.deepEqual(asItemArray({ item: [{ a: 1 }, { a: 2 }] }), [{ a: 1 }, { a: 2 }]);
    assert.deepEqual(asItemArray([{ a: 1 }]), [{ a: 1 }]);
    assert.deepEqual(asItemArray(""), []);
    assert.deepEqual(asItemArray({ item: "" }), []);
  });
});

describe("게이트웨이 오류", () => {
  it("XML 사유 코드를 읽고, 인증·한도 오류는 재시도하지 않는다", () => {
    const xml = "<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>22</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>";
    assert.equal(gatewayReasonCode(xml), "22");
    assert.equal(gatewayReasonCode("{\"response\":{}}"), null);
    assert.equal(isFatalGatewayCode("22"), true);
    assert.equal(isFatalGatewayCode("30"), true);
    assert.equal(isFatalGatewayCode("01"), false);
  });
});

describe("kioskKey", () => {
  it("선행 0을 떼고 개방자치단체코드와 묶는다", () => {
    assert.equal(kioskKey("3710000", "0501"), "3710000:501");
    assert.equal(kioskKey(" 3710000 ", 501), "3710000:501");
    assert.equal(kioskKey("3710000", "000"), "3710000:0");
  });
});

describe("pickInstallationFields", () => {
  it("앱이 쓰는 필드만 남기고 빈 값은 뺀다", () => {
    const picked = pickInstallationFields({
      MNG_NO: "501",
      ISSUMCHN_NM: " 동구청 ",
      ROAD_CD: "123",
      OPER_HR_REF_CN: "",
      FAM_REL_DEL_ISSU_SE: "발급",
      INSTL_PLC_PSTN: null
    });
    assert.deepEqual(picked, { MNG_NO: "501", ISSUMCHN_NM: "동구청", FAM_REL_DEL_ISSU_SE: "발급" });
  });
});

const installation = [
  { MNG_NO: "501", OPN_ATMY_GRP_CD: "3710000", CTPV_CD: "6310000", ISSUMCHN_NM: "동구청" },
  { MNG_NO: "12", OPN_ATMY_GRP_CD: "3700000", CTPV_CD: "6310000", ISSUMCHN_NM: "남구청" },
  { MNG_NO: "7", OPN_ATMY_GRP_CD: "3000000", CTPV_CD: "6110000", ISSUMCHN_NM: "종로구청" },
  { MNG_NO: "", OPN_ATMY_GRP_CD: "3000000", CTPV_CD: "6110000" },
  { MNG_NO: "8", OPN_ATMY_GRP_CD: "3000000" }
];

describe("groupKiosksBySido", () => {
  it("시도별로 나누고 관리번호·시도가 없는 행은 버린다", () => {
    const { bySido, dropped } = groupKiosksBySido(installation);
    assert.equal(dropped, 2);
    assert.deepEqual([...bySido.keys()].sort(), ["6110000", "6310000"]);
    assert.deepEqual(bySido.get("6310000").map((row) => row.MNG_NO), ["12", "501"]);
  });
});

describe("compactCertificates", () => {
  it("시도별 서류 사전과 발급기별 번호 목록으로 줄인다", () => {
    const certs = [
      { ISSUMCHN_NO: "0501", OPN_ATMY_GRP_CD: "3710000", SGG_NM: "울산광역시 동구", INITA_MENU_NM: "주민등록", CVLCPT_OFCWORK_CLSF_NO: "10", CVLCPT_OFCWORK_CLSF_NM: "주민등록표 등본" },
      { ISSUMCHN_NO: "501", OPN_ATMY_GRP_CD: "3710000", SGG_NM: "울산광역시 동구", INITA_MENU_NM: "가족관계등록부", CVLCPT_OFCWORK_CLSF_NO: "20", CVLCPT_OFCWORK_CLSF_NM: "가족관계증명서" },
      { ISSUMCHN_NO: "501", OPN_ATMY_GRP_CD: "3710000", SGG_NM: "울산광역시 동구", INITA_MENU_NM: "주민등록", CVLCPT_OFCWORK_CLSF_NO: "10", CVLCPT_OFCWORK_CLSF_NM: "주민등록표 등본" },
      { ISSUMCHN_NO: "12", OPN_ATMY_GRP_CD: "3700000", SGG_NM: "울산광역시 남구", INITA_MENU_NM: "주민등록", CVLCPT_OFCWORK_CLSF_NO: "10", CVLCPT_OFCWORK_CLSF_NM: "주민등록표 등본" },
      { ISSUMCHN_NO: "9", OPN_ATMY_GRP_CD: "9999999", CVLCPT_OFCWORK_CLSF_NM: "모르는 지역" }
    ];
    const { bySido, used, unmapped } = compactCertificates(certs, localGovToSido(installation));
    assert.equal(used, 4);
    assert.equal(unmapped, 1);
    const ulsan = bySido.get("6310000");
    assert.deepEqual(ulsan.documents, [
      ["10", "주민등록표 등본", "주민등록"],
      ["20", "가족관계증명서", "가족관계등록부"]
    ]);
    assert.deepEqual(ulsan.kiosks, {
      "3700000:12": { district: "울산광역시 남구", docs: [0] },
      "3710000:501": { district: "울산광역시 동구", docs: [0, 1] }
    });
  });
});

describe("assertPlausibleCount", () => {
  it("하한과 직전 배포 90% 미만을 막는다", () => {
    assert.doesNotThrow(() => assertPlausibleCount("x", 950, { minimum: 100, previous: 1000 }));
    assert.throws(() => assertPlausibleCount("x", 899, { previous: 1000 }), /90%/);
    assert.throws(() => assertPlausibleCount("x", 50, { minimum: 100 }), /하한/);
  });
});

describe("isCertificateRefreshDay", () => {
  it("KST 일요일이면 참이다", () => {
    assert.equal(isCertificateRefreshDay(new Date("2026-10-10T18:00:00Z")), true); // 10/11(일) 03:00 KST
    assert.equal(isCertificateRefreshDay(new Date("2026-10-11T18:00:00Z")), false); // 10/12(월) 03:00 KST
  });
});
