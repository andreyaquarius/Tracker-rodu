# Production-сторінка родового дерева

## Архітектура

Сторінка використовує чинний граф застосунку. `public.persons` залишається єдиним канонічним записом особи; членство та зв’язки зберігаються в `family_tree_persons`, `family_groups`, `partner_relationships`, `parent_sets` і `parent_child_relationships`. Нових таблиць осіб або вкладеного `children[]` JSON немає.

Основні файли:

- `src/pages/FamilyTreePage.tsx` — façade і rollback на старий renderer.
- `src/pages/ProductionFamilyTreePage.tsx` — production orchestration, toolbar, focus/history/search, parent-set policy, dialogs і neighborhood merge.
- `src/services/familyTreeNeighborhoodService.ts` — abortable authenticated REST-виклик RPC.
- `src/features/family-tree-view/adapters/trackerFamilyTreeAdapter.ts` — lossless adapter чинних DTO до `TreePerson`/`TreeUnion`/`ParentChildRelation`.
- `src/features/family-tree-view/layout/` — pure deterministic occurrence layout і PAVA packing.
- `src/features/family-tree-view/layout/directAncestorLayout.ts` — constrained direct-pedigree grid для 4–7 поколінь: child під точним midpoint батьків, рекурсивні paternal/maternal half-planes не перетинаються.
- `src/features/family-tree-view/worker/` — layout Worker із monotonic revision.
- `src/features/family-tree-view/react/` — camera, Canvas edges, viewport culling, fixed-size cards і semantic list.
- `supabase/migrations/202607100001_family_tree_neighborhood.sql` — graph version, cycle guards, RLS і RPC.
- `supabase/migrations/202607100002_family_tree_neighborhood_performance.sql` — індексований bounded traversal, set-based continuations і безпечні defaults `7/0/0` для великих дерев.
- `supabase/tests/family_tree_neighborhood_test.sql` — PostgreSQL/RLS/privacy/pagination integration fixture.
- `supabase/tests/family_tree_neighborhood_initial_scope_test.sql` — ancestor-only initial scope та окреме розкриття напрямків біля картки.
- `supabase/tests/family_tree_neighborhood_performance_test.sql` — регресія на 2480 осіб із `statement_timeout = 15s`.

`personId` і `occurrenceId` навмисно різні. Одна канонічна особа може мати основну картку та reference-входження; adapter не генерує новий canonical ID. Partnership union має ID `partnership:<uuid>`, parent-set union — `parent-set:<uuid>`.

## Neighborhood RPC

Authenticated endpoint PostgREST:

```text
POST /rest/v1/rpc/get_family_tree_neighborhood_v1
```

Початковий body:

```json
{
  "p_request": {
    "treeId": "uuid",
    "focusPersonId": "uuid",
    "ancestorDepth": 7,
    "descendantDepth": 0,
    "collateralDepth": 0,
    "maxNodes": 400,
    "knownGraphVersion": "optional bigint string"
  }
}
```

Розкриття окремої гілки додає `branches[]` з `personId`, унікальним масивом `directions` (`parents`, `children`, `partners`, `siblings`) і cursor на напрямок. Cursor є opaque hex token, але сервер перевіряє його version, tree, person, direction, graphVersion, key types і довжину. Дублікати `(personId, direction)` відхиляються, тому результат не залежить від порядку branch objects.

Відповідь:

```json
{
  "persons": [],
  "unions": [],
  "parentChildRelations": [],
  "continuations": [],
  "graphVersion": "42",
  "permissionFingerprint": "project-viewer:living-masked:v1"
}
```

`maxNodes` є ресурсним budget: default 400, server hard limit 600. Це не межа поколінь або розміру дерева. Невміщені сусіди повертаються як keyset continuation; `hiddenCount` рахує канонічних осіб, а не appearance/reference cards. Cursor key — `display_order + relation date + relationship UUID`; offset pagination не використовується.

Початковий перегляд завантажує фокусну особу та до семи поколінь її прямих предків. Нащадки, брати/сестри, партнери й інші бічні родичі не входять до initial response; сервер повертає для них continuation конкретної особи, і UI розкриває лише натиснутий напрямок.

Production-layout відображає весь уже завантажений bounded-граф, тому branch response не фільтрується повторно початковими `0/0`. Розмір наступної branch page автоматично обмежується вільним місцем до 600 канонічних осіб з урахуванням повтореного anchor; на межі користувачеві пропонується зробити потрібну особу новим фокусом. Layout-only continuation не перезапускає базовий RPC і не втрачає раніше розкриті гілки.

У direct-ancestor view використовується окрема compact grid, а не soft bundle/PAVA solver. Партнер прямого предка враховується як асиметричний footprint його картки та ставиться назовні від локальної батьківської/материнської пари; після розкриття партнера всі рівні перераховуються, але жодна картка батьківського сектора не перетинає вісь материнського й навпаки. Continuation і add-parent controls прикріплюються компактним action rail під відповідною карткою та не впливають на ширину покоління. Сімейна bus завжди охоплює і `unionX`, і центри дітей, тому вертикаль подружжя, horizontal bus та child stems утворюють одну безперервну геометрію.

Initial traversal зберігає окремі nondominated depth states для pedigree collapse/repeated ancestors. Output усе одно має одну канонічну особу на ID, а bounded state-work зупиняє патологічне множення шляхів; невідібрані сусіди залишаються доступними через continuation.

## Авторизація і приватність

- RPC вимагає `auth.uid()` і membership у project дерева.
- Owner/editor отримують дозволені точні поля; viewer бачить server-generated placeholder `Приватна особа` для живої private/confidential особи.
- Для masked person network payload не містить точного імені, статі, birth/death dates; relationship kind/role, partnership status/dates і parent-set type теж маскуються, якщо вони розкривають приватну живу особу.
- Direct-table RLS повністю прибирає для viewer точні private-living person/name/event rows та exact relationship/family-group/parent-set rows, через які їх можна вивести.
- Confidential edges не потрапляють у traversal або payload для користувача без edit permission.
- Cache key включає tree, graphVersion, focus/depth/filter policy і permission fingerprint. Зміна структури або display-полів особи монотонно збільшує `family_trees.graph_version`.

## Mutation invariants

Server trigger перевіряє self-cycle, parent-set/tree/child identity і повний reachable parent cycle без generation cap. Tree rows блокуються в стабільному UUID-порядку для concurrent cross-tree moves. Client guard додатково перевіряє attach/import до mutation.

Не-біологічні parent roles (`adoptive`, `foster`, `guardian`, `step`, `donor`, `surrogate`, genetic/gestational/birth/legal/social/presumed/other) не створюють partnership автоматично. Дитина залишається прив’язаною до конкретного `ParentSet`/`FamilyGroup`, а partnership і parent set не змішуються.

## Renderer і доступність

- Layout виконується у Web Worker; stale revision responses ігноруються.
- Лінії малює Canvas, а DOM містить лише viewport + overscan, не більше 600 card/list items.
- Camera підтримує pan, cursor-centered wheel zoom, touch pan/pinch, fit, center-on-focus і anchor compensation після expand.
- Search змінює лише visual focus; `family_trees.root_person_id` не записується.
- Collapse/re-expand, open, focus та add-relative доступні і в картці, і в semantic list через native buttons/ARIA.
- Reduced-motion CSS вимикає необов’язкові переходи. Privacy/reference/cycle стани мають текстові labels/badges, а не лише колір.

## Feature flag і rollback

Міграція історично створювала rollout flag `family_tree_renderer_v2`. Після загального запуску модуль використовує production renderer для кожного авторизованого користувача і більше не повертається до старого інтерфейсу через відсутній або вимкнений flag. Доступ до даних і редагування надалі визначаються членством у проєкті, роллю та тарифними лімітами.

## Перевірка

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:integration
npm.cmd run test:e2e
npm.cmd run benchmark:family-tree
npm.cmd run build
```

Для реальної БД:

```powershell
npx.cmd supabase start
npx.cmd supabase db reset --local
npm.cmd run test:db
```

DB suite має 44 assertions: viewer/editor privacy, tenant isolation, direct RLS, ancestor-only initial scope, окремі branch expansions, 200-child keyset pagination, 2480-person timeout regression, cursor rejection, canonical hidden count, graph-version bump, cycle/self-cycle rejection, cousin/related partnership without false cycle і repeated-ancestor nondominated traversal.

Перед release вручну пройдіть visual interaction smoke test у підтримуваному browser: wheel/pinch/pan, fit/focus/fullscreen, back/forward focus history, search, continuation, collapse/re-expand, keyboard-only semantic list, reduced motion і responsive toolbar.
