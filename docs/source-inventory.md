# Source coverage inventory

Live audit date: 2026-09-29.

This inventory records source-level coverage, adapter fit, and official instance policy. Policy membership does not prove that a public deployment is active; adding a registry YAML file alone also does not add the source to `instances/official.json`.

## Registered before M2A

| Source | URL | Organization | Audience relevance | Adapter/status | Notes |
| --- | --- | --- | --- | --- | --- |
| Undergraduate School academic calendar | https://jw.nju.edu.cn/24809/list.htm | 本科生院 | Undergraduate students and teaching staff | WebPlus; registered | Calendar/resource stream rather than a general notice stream. |
| Undergraduate School notices | https://jw.nju.edu.cn/ggtz/list.htm | 本科生院 | Undergraduate students and teaching staff | WebPlus; registered | Public list may include restricted details; current collector preserves those as link-only observations. |
| Graduate School notices | https://grawww.nju.edu.cn/905/list.htm | 研究生院 | Graduate students, supervisors, and graduate administrators | WebPlus; registered | General graduate education notices. |
| Student Affairs notices | https://xgb.nju.edu.cn/gsgg/list.htm | 党委学生工作部 | Students | WebPlus; registered | Mixed first-party, public-WeChat, and other public links are retained from the official list. |
| Youth League announcements | https://tuanwei.nju.edu.cn/ggtz/list.htm | 共青团南京大学委员会 | Students and student organizations | WebPlus; registered | Some first-party details can be campus-network restricted. |
| Student Exchange notices | https://stuex.nju.edu.cn/2539/list.htm | 国际化工作处学生交流办公室 | Students seeking exchange opportunities | WebPlus; registered | Some first-party details can be campus-network restricted. |
| ITSC notices | https://oi.nju.edu.cn/tzgg/listm.htm | 信息化建设管理服务中心 | All campus users | WebPlus; registered | Campus IT and service-operation notices. |
| Library news, activities, and notices | https://lib.nju.edu.cn/xw/xwtz.htm | 南京大学图书馆 | Students, faculty, and researchers | WebPlus with selectors; registered | Intentionally a mixed stream, not notice-only. |
| Science and Technology Office notices | https://scit.nju.edu.cn/10916/list.htm | 科学技术处 | Researchers, faculty, and research administrators | WebPlus; registered | Research administration and project notices. |
| Computer Science graduate notices | https://cs.nju.edu.cn/1703/list.htm | 计算机学院 | CS graduate students and supervisors | WebPlus; registered | College-level graduate stream. |
| Computer Science internal notices | https://cs.nju.edu.cn/1702/list.htm | 计算机学院 | CS students and staff | WebPlus; registered | College-wide internal-facing public notices. |
| Computer Science seminars | https://cs.nju.edu.cn/1706/list.htm | 计算机学院 | CS and research community | WebPlus; registered | Seminar and lecture stream. |

## M2A-validated WebPlus sources selected by M2B policy

These sources were proven compatible with the existing generic adapter in M2A and are selected in `instances/official.json` for collection and independent per-source publication. They are not members of the `cs` curated set. The localhost Docker/Compose instance is the current test publisher. The GitHub Pages workflow has `state=disabled_manually` and must remain disabled, so Pages is not currently publishing this policy and deployment acceptance remains pending.

| Source | URL | Organization | Audience relevance | Adapter/status | Live evidence and notes |
| --- | --- | --- | --- | --- | --- |
| Security Office notices | https://bwc.nju.edu.cn/64525/list.htm | 南京大学保卫处 | All campus users; safety, traffic, office hours, and procurement | WebPlus defaults; configured in official instance | Sudy/WebPlus HTML exposes `.listcon .news_list`, 14 rows on page 1, 412 total records, `/page.htm` details, and standard paging. Generic discovery returned dated first-party items. The newest detail parsed successfully and exposed one PDF attachment. |
| Psychology Center bulletin | https://njuxlzx.nju.edu.cn/47935/list.htm | 心理健康教育与研究中心 | Primarily students; counseling services, workshops, and mental-health activities | WebPlus with `listItem`; configured in official instance | Sudy/WebPlus HTML exposes 14 dated list rows and 308 total records, but most current rows link to public WeChat. `.news_list li.news` retains the full official list: live discovery classified the first four rows as `public-wechat` and the fifth as `webplus-detail`. Fetch skipped the four unsupported public-WeChat details and parsed the first-party duty-roster detail successfully. |
| Logistics Group public notices | https://hqjt.nju.edu.cn/1214/list.htm | 后勤服务集团 | Students and staff using dining, housing, transport, and campus services | WebPlus with `listItem`; configured in official instance | The homepage's “公告通知” link identifies `/1214/list.htm` as the canonical list. It contains 14 rows on page 1, 79 total records, local WebPlus details, and external public procurement links. `.news_list li.news` preserves both: live discovery classified local rows as `webplus-detail` and cross-site rows as `external-public`. The newest local detail parsed successfully and exposed one PDF attachment. |

All three use `recentLimit: 5`. Their first pages span months rather than days; five candidates bound initial detail traffic while retaining the newest source-item observations. Psychology's newest candidates are mostly public-WeChat links, and Logistics mixes external public links, so larger limits would mainly add unsupported detail attempts rather than more full notices.

Before activation, isolated empty-database ingestion with limit 5 visited two pages and observed 28 items for each source. Security produced 5 full revisions and 23 link-only entries; Psychology produced 1 full revision and 27 public-WeChat link-only entries; Logistics produced 3 full revisions, 2 external-public observations, and 25 total link-only entries. No retained runtime database was used.

## M2C-validated Boshan sources

These sources share the same public Boshan list API and are registered through one reusable `boshan` adapter. M2D selects both in `instances/official.json` for independent per-source publication; they are not added to the `cs` curated set.

| Source | URL | Organization | Audience relevance | Adapter/status | Live evidence and notes |
| --- | --- | --- | --- | --- | --- |
| University Hospital announcements | https://hospital.nju.edu.cn/xwgg/ggtz/index.html | 南京大学医院 | Students and staff; health services, insurance, vaccination, and clinic schedules | Boshan (`channelId=18099`); official instance | Public list discovery uses `/njdx/openapi/t/info/list.do`; stable identity is the API `iid`. Detail pages expose `ArticleTitle` / `PubDate` metadata and `#zoom` content. Empty-database live ingest with limit 5 visited 2 pages, observed 30 items, inserted 5 full revisions, and found 1 attachment. |
| Asset Management notices | https://zcc.nju.edu.cn/sy/tzzhxx/index.html | 资产管理处 | Staff and units; housing, assets, campus premises, and procurement; occasional student housing relevance | Boshan (`channelId=13968`); official instance | Uses the same public list API and `iid` identity; detail content is configured as `#word`. Empty-database live ingest with limit 5 visited 2 pages, observed 30 items, inserted 5 full revisions, and found 3 attachments. |

The adapter normalizes same-host API links to the source HTTPS origin before persistence, so legacy `http://host//path` values returned by the API do not leak into feeds. Fixture tests cover paging, channel mismatch failure, configured detail selectors, URL normalization, and DFS attachments. M2D live migration upgraded the retained localhost database from schema v3 to v4 without losing prior observations; the first 14-source startup run kept all existing sources bounded and added 5 full revisions from each Boshan source. JSON/Atom/RSS endpoints for both new sources returned HTTP 200, with unique JSON Feed item IDs and working ETag/304 revalidation.

## M2E-validated employment information sources selected by M2F policy

The employment portal is a Vue/Vite client backed by a stable public JSON API. M2E registered three independent streams through one `job-portal-information` adapter; M2F admits all three to `instances/official.json` for independent per-source publication.

| Source | URL | Organization | Audience relevance | Adapter/status | Live evidence and notes |
| --- | --- | --- | --- | --- | --- |
| Employment news | https://job.nju.edu.cn/career/info?type=NEWS | 南京大学学生就业指导中心 | Students and graduates; employment announcements and major recruiting events | Public JSON API; official instance | Full audit found 104 public `PUBLISHED` records with unique IDs, content and publication dates. Empty-database ingest with limit 5 visited 2 pages, observed 30 items, inserted 4 full revisions, retained 1 explicit external link-only item, and found 6 attachments. |
| Employment college updates | https://job.nju.edu.cn/career/info?type=COLLEGE | 南京大学学生就业指导中心 | Students; college-level employment activity and practice updates | Public JSON API; official instance | Full audit found 19 public `PUBLISHED` records with unique IDs and no login requirement. Empty-database ingest with limit 5 visited 2 pages, observed all 19 items, and inserted 5 full revisions. |
| Employment guidance | https://job.nju.edu.cn/career/info?type=GUIDE | 南京大学学生就业指导中心 | Students; career guidance and employability activities | Public JSON API; official instance | Full audit found 18 public `PUBLISHED` records with unique IDs and no login requirement. Empty-database ingest with limit 5 visited 2 pages, observed all 18 items, and inserted 5 full revisions. |

The portal returns full HTML, attachments, stable record IDs and publication dates from `/api/career/content/informations`. Feed items keep the human-facing `/career/info/<id>?type=...` URL while detail provenance is fetched from the corresponding API record. The API returned HTTP 401 only when the client incorrectly advertised HTML-only content; the shared fetcher now truthfully advertises both HTML and JSON support, with a regression test. No cookie, token or login session is used.
M2F live admission reused the retained localhost database and upgraded it from schema v4 to v5 without losing prior history. The first 17-source startup run moved from 14 sources / 420 observations / 109 revisions to 17 sources / 487 observations / 123 revisions. All three employment streams stayed bounded to two list pages: NEWS observed 30 items and inserted 4 full revisions plus one external link-only candidate; COLLEGE and GUIDE observed 19 and 18 items and inserted 5 full revisions each. A second one-shot collection again visited two pages for every official source and inserted zero new revisions for all three employment streams, leaving total revisions at 123. JSON/Atom/RSS endpoints for all three streams returned HTTP 200; a representative JSON Feed ETag revalidation returned HTTP 304 with an empty body.

## M2G-validated employment recruitment source selected by M2H policy

| Source | URL | Organization | Audience relevance | Adapter/status | Live evidence and notes |
| --- | --- | --- | --- | --- | --- |
| Employment recruitments | https://job.nju.edu.cn/career/jobs-v2 | 南京大学学生就业指导中心 | Students and graduates seeking positions | Public JSON API; official instance | Full audit covered all 2,866 public recruitment records across 29 API pages: IDs were unique, every record was `PUBLISHED` and enabled, and every record had a stable `applyAt`. The adapter keeps one recruitment batch as one source item, uses `/career/jobs-v2?recruitmentId=<id>` as the human-facing URL, and normalizes nested positions into the notice body. Empty-database ingest with limit 5 visited 2 pages, observed 40 items, and inserted 5 full revisions; the immediate second ingest again visited 2 pages with 0 inserted / 5 unchanged revisions. A live parsed notice included the employer, deadline, recruitment introduction, and structured position details. |

Records without an introduction or position array remain valid: the full audit found 303 such records, but none lacked all summary content (company/contact/deadline) at the same time. No browser, cookie, token, or login session is used.

M2H live admission was replayed from the retained schema-v5 pre-admission snapshot (17 sources / 487 observations / 123 revisions) after an unrelated resumed OMP session had polluted the localhost state. The clean first 18-source startup run kept all existing sources bounded, added the recruitment source at 2 pages / 40 observations / 5 full revisions, and simultaneously detected one real new Youth League item/revision; the resulting database was 18 sources / 528 observations / 129 revisions. The immediate second collection again kept all official sources bounded and recruitment at 2 pages with 0 inserted / 5 unchanged revisions, with global totals unchanged. Recruitment JSON/Atom/RSS endpoints all returned HTTP 200 with 40 entries and unique JSON Feed IDs; ETag revalidation returned HTTP 304 with an empty body.

## M2I-validated representative college sources

This batch tests the configuration-first goal across several college site families. All four sources are registered independently and remain outside `instances/official.json` until the separate admission step.

| Source | URL | Organization | Audience relevance | Adapter/status | Live evidence and notes |
| --- | --- | --- | --- | --- | --- |
| Artificial Intelligence notices | https://ai.nju.edu.cn/17810/list.htm | 人工智能学院 | AI undergraduate/graduate students and faculty | WebPlus defaults; registered | Standard Sudy/WebPlus list with 14 items per page. Empty-database ingest with limit 5 visited 2 pages, observed 28 items, inserted 5 full revisions, and found 6 attachments. Immediate second ingest stayed at 2 pages with 0 inserted / 5 unchanged. |
| Software School notices | https://software.nju.edu.cn/tzgg/index.html | 软件学院 | Software students and faculty | Boshan (`channelId=6439`); registered | Boshan list API exposes 15 items/page. Detail content uses `.content`; current notices commonly embed PDFs as `span.edui-pdf[data-pdf]`. The shared HTML parser now recognizes that generic editor representation. Empty-database ingest visited 2 pages, observed 30 items, inserted 5 full revisions, and preserved 5 PDF attachments; second ingest inserted 0. |
| Mathematics announcements | https://math.nju.edu.cn/sy/yxgg/index.html | 数学学院 | Mathematics students and faculty | Boshan (`channelId=16411`); registered | Detail content uses `.article_content`. Empty-database ingest visited 2 pages, observed 30 items, inserted 5 full revisions, and found 9 attachments; second ingest inserted 0. Restricted same-site detail links remain subject to the existing restriction handling. |
| Physics notices | https://physics.nju.edu.cn/xwdt/tzggxlycgzhd/index.html | 物理学院 | Physics students and faculty | Boshan (`channelId=16198`); registered | The list includes an older pinned row ahead of current notices, exercising date-ranked bootstrap rather than first-row stopping. Detail content uses `.mn-contentInfo`. Empty-database ingest visited 2 pages, observed 30 items, inserted 5 full revisions, and found 5 attachments; second ingest inserted 0. |

The four sources required no college-specific TypeScript branches. AI reused the existing WebPlus adapter; the three Boshan colleges reuse the same Boshan list/detail boundary already used by Hospital and Asset Management. The only code change was generic support for Boshan editor PDFs stored in `data-pdf`, covered by fixture tests.

## Deferred

| Source | URL | Organization | Audience relevance | Adapter/status | Live evidence and notes |
| --- | --- | --- | --- | --- | --- |
| Employment recruiting events | https://job.nju.edu.cn/career/specifics | 南京大学学生就业指导中心 | Students and graduates attending recruiting events | Public JSON APIs; audited, not registered | `/api/career/job/fair/specifics` and `/api/career/job/fair/mutual-selections` are anonymously readable and expose stable IDs plus structured start/end times. Public detail routes are `/career/specifics/<id>` and `/career/mutual-selections/<id>`. These are event entities rather than publication notices, so they should wait for an explicit event canonical model instead of treating event time as publication time. |
| Electronic Science and Engineering announcements | https://ese.nju.edu.cn/22538/list.htm | 电子科学与工程学院 | Electronic-science students and faculty | Public-network restricted; not registered | The official “通知与公告” route redirects public-network requests to a prompt stating that the current IP is not a campus address and the content is campus-only. The public core does not bypass that restriction. |
