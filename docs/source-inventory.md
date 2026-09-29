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

These sources share the same public Boshan list API and are registered through one reusable `boshan` adapter. They are not yet selected by `instances/official.json`; registration and official publication remain separate review steps.

| Source | URL | Organization | Audience relevance | Adapter/status | Live evidence and notes |
| --- | --- | --- | --- | --- | --- |
| University Hospital announcements | https://hospital.nju.edu.cn/xwgg/ggtz/index.html | 南京大学医院 | Students and staff; health services, insurance, vaccination, and clinic schedules | Boshan (`channelId=18099`); registered | Public list discovery uses `/njdx/openapi/t/info/list.do`; stable identity is the API `iid`. Detail pages expose `ArticleTitle` / `PubDate` metadata and `#zoom` content. Empty-database live ingest with limit 5 visited 2 pages, observed 30 items, inserted 5 full revisions, and found 1 attachment. |
| Asset Management notices | https://zcc.nju.edu.cn/sy/tzzhxx/index.html | 资产管理处 | Staff and units; housing, assets, campus premises, and procurement; occasional student housing relevance | Boshan (`channelId=13968`); registered | Uses the same public list API and `iid` identity; detail content is configured as `#word`. Empty-database live ingest with limit 5 visited 2 pages, observed 30 items, inserted 5 full revisions, and found 3 attachments. |

The adapter normalizes same-host API links to the source HTTPS origin before persistence, so legacy `http://host//path` values returned by the API do not leak into feeds. Fixture tests cover paging, channel mismatch failure, configured detail selectors, URL normalization, and DFS attachments.

## Deferred

| Source | URL | Organization | Audience relevance | Adapter/status | Live evidence and notes |
| --- | --- | --- | --- | --- | --- |
| Employment portal | http://job.nju.edu.cn/ | 就业指导中心 | Students and graduates seeking employment | Separate Vue/Vite application; deferred | The root document is an application shell loading `/_app.config.js` and a module bundle under `/jse/`; it contains no public notice list in server HTML. Generic WebPlus discovery returned `[]`. Do not assume WebPlus compatibility or design a one-off scraper; audit its public API/content model separately. |
