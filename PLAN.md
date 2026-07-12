# План інтеграції необмеженого родового дерева

## Мета й незмінні рішення

- Канонічна особа залишається записом `public.persons`; `family_tree_persons` є лише членством у дереві.
- Родинна модель залишається графом із наявних `family_trees`, `family_groups`, `partner_relationships`, `parent_sets` і `parent_child_relationships`.
- `personId` та `occurrenceId` не об’єднуються. Повторний предок має одну канонічну особу й кілька візуальних входжень.
- `PartnerRelationship` та `ParentSet` адаптуються в різні типи union. Візуальні ID мають простори імен `partnership:` і `parent-set:`.
- Донорство, сурогатне материнство, опіка, усиновлення, виховання та step-зв’язок самі по собі не створюють партнерство.
- Візуальний фокус є локальним станом перегляду й не змінює `family_trees.root_person_id`.
- Сім поколінь — початкове значення запиту, а не межа схеми чи layout-ядра.
- Звичайний перегляд використовує обмежений neighborhood-запит; повне дерево не завантажується одним endpoint.

## Фактична карта наявного коду

### Домен і БД

- `src/types/familyTree.ts` — чинні типи `FamilyTree`, `FamilyTreePerson`, `FamilyGroup`, `PartnerRelationship`, `ParentSet`, `ParentChildRelationship`, канонічні node DTO та occurrence DTO.
- `supabase/migrations/202606290003_family_tree_graph_foundation.sql` — усі графові таблиці, RLS і поточний trigger перевірки bloodline-cycle.
- `supabase/migrations/202606290004_family_tree_person_facts.sql` — варіанти імен і події життя.
- `supabase/migrations/202607010001_family_tree_legacy_sync.sql` — синхронізація `persons`/`person_relations` із графом, `is_living` і `privacy_status`.
- `src/services/familyTreeGraphRepository.ts` — поточне читання всіх рядків дерева та всіх осіб проєкту.
- `src/services/familyTreeGraphService.ts` — побудова старого повного `FamilyTreeGraphDto`, occurrence та issues.
- `src/services/familyTreeMutationService.ts` — чинні UI-mutation; зараз це кілька окремих PostgREST-операцій.
- `src/utils/gedcom*.ts` — чинні GEDCOM import/export; не дублювати.

### Авторизація і приватність

- `public.is_project_member(project_id)` дає читання owner/editor/viewer; `public.can_edit_project(project_id)` дає запис owner/editor.
- RLS на графових таблицях перевіряє членство/редагування, але не маскує поля живих осіб.
- Поточна маска в `familyTreeGraphService.ts` застосовується після network response, тому не є достатнім privacy boundary.
- У схемі немає `graph_version`, neighborhood RPC, continuation cursor або permission fingerprint — для них доведена потреба в новій міграції.

### UI, який треба зберегти

- `src/pages/FamilyTreePage.tsx` — чинна orchestration і rollback-renderer.
- `src/pages/PersonsPage.tsx` + `src/components/PersonFormModal.tsx` — наявні перегляд і редагування особи.
- `src/pages/CrudPage.tsx` — наявні панелі документів, знахідок, завдань, гіпотез та інших матеріалів.
- `src/components/familyTree/FamilyTreePersonDialog.tsx` і `FamilyTreeAttachPersonDialog.tsx` — створення/приєднання родичів.
- `src/components/familyTree/FamilyTreeSidePanel.tsx`, `FamilyTreeIssuesPanel.tsx`, `FamilyTreeLegend.tsx` — наявні панелі, які мають лишитися доступними.
- `src/styles.css` — дизайн-система застосунку (Manrope/Source Serif, зелено-кремова палітра, стандартні panel/button/form/modal).
- `src/App.tsx`, `src/components/Sidebar.tsx`, `src/utils/appRoutes.ts` — уже наявний маршрут `/projects/:slug/rodove-derevo`.

## Файли інтеграції

1. Перенести pure layout, worker, camera, Canvas edges, semantic list і neighborhood client із комплекту в `src/features/family-tree-view/`, зберігши незалежність layout від Supabase і UI застосунку.
2. Додати конкретний typed adapter поруч із generic `createTrackerFamilyTreeAdapter`, який lossless-мапить чинні DTO, нормалізує стать/дати/порядок, розділяє partnership і parent-set та не створює нових canonical ID.
3. Додати Supabase migration для:
   - монотонного `family_trees.graph_version` і trigger-інвалідації;
   - авторизованого `get_family_tree_neighborhood_v1(p_request jsonb)`;
   - server-side masking живих приватних осіб;
   - finite `maxNodes`, стабільного keyset cursor (`display_order`, date, relationship ID) та canonical `hiddenCount`;
   - перевірки branch token/tree/version/permission;
   - cycle guard без глобальної межі поколінь.
4. Додати production page/view wrapper, який за замовчуванням використовує neighborhood RPC + worker renderer, а чинний renderer залишає rollback-гілкою feature flag до завершення перевірок.
5. Зберегти наявні workspace windows, person CRUD, source/finding/document links і dialogs. Новий renderer передає тільки callback-и `open`, `focus`, `add relative`, `expand continuation`.
6. Виправити mutation semantics: parent-set не породжує partnership; перед parent→child mutation/import діють client і server cycle guards; structural mutation змінює graph version.

## Перевірки

- Портувати deterministic layout/PAVA/property сценарії у наявний Node test runner без введення другого test stack.
- Додати adapter, merge/cache, stale request, cycle, parent-set/partnership, 14 дітей, 3 партнери, repeated ancestor, 50 поколінь, 200 siblings/keyset і keyboard semantic-list тести.
- Додати SQL integration fixtures для RLS tenant isolation, viewer masking, owner/editor permission, graph-version bump і негативних cycle mutation.
- Додати browser E2E/visual QA для wheel/pinch, fit/focus/fullscreen, focus history, branch expand/re-expand/collapse, reduced motion і DOM-card budget.
- Обов’язкові команди: `npm.cmd run lint`, `npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run test:integration`, `npm.cmd run test:e2e`, `npm.cmd run build`.

## Відомі ризики й обмеження

- Worktree уже містить великі незакомічені зміни користувача. Не перезаписувати файли wholesale і не видаляти старий renderer у цій зміні.
- Старий repository path завантажує весь граф, усі профілі, імена й події; production path не повинен викликати його безумовно.
- Поточний cycle trigger має межу 128 рівнів; її треба замінити visited-path перевіркою.
- Поточні mutation можуть автоматично створити partnership для не-партнерських parent-set ролей і можуть синхронізувати non-default tree relation у default tree через legacy trigger.
- Generic модуль має локальні `local:*` continuation tokens; вони не повинні надсилатися на сервер. Локальне collapse/parent-set перемикання та server continuation мають різні handlers.
- Supabase JS RPC не підтримує справжнє скасування HTTP через переданий AbortSignal у generic wrapper; stale responses треба ігнорувати revision-ом, а branch transport за можливості виконувати через abortable HTTP.
- Немає налаштованого DB/E2E runner у початковому `package.json`; якщо Docker/Supabase або browser runtime недоступні, це треба зафіксувати як неперевірений зовнішній ризик, а не називати тест зеленим.

## Базова точка перед інтеграцією

- `npm.cmd run lint` — успішно.
- `npm.cmd test` — 212/212 успішно.
- `npm.cmd run build` — успішно; є лише наявні warnings про legal config і великий JS chunk.
- Integration/E2E scripts у базовій точці відсутні.

## Стан після інтеграції

### Етап 1 — аудит

- Завершено. Канонічні таблиці, RLS, route, dialogs і rollback-renderer зафіксовані вище; паралельної моделі осіб не створено.

### Етап 2 — adapter і layout

- Завершено в `src/features/family-tree-view/` та `trackerFamilyTreeAdapter.ts`.
- Pure layout лишився незалежним від React/Supabase; Worker має монотонний revision, лінії малює Canvas, картки cull-яться до жорсткої межі 600 mounted items.
- Для direct pedigree додано constrained grid 4–7 поколінь із точним parent midpoint та строгими paternal-left/maternal-right half-planes; партнери прямих предків розширюють лише footprint свого сектора назовні, а continuation/placeholder controls більше не беруть участі у packing.
- Family routing topology замикає partnership junction → family stem → siblings bus → child stem без геометричних розривів, навіть коли parent midpoint і child center різні.
- Тести покривають 14 дітей, три партнерства, різні parent sets, repeated ancestor/reference, цикли, 80 поколінь, PAVA та input-order determinism.

### Етап 3 — neighborhood RPC, приватність і великі дерева

- Завершено в `202607100001_family_tree_neighborhood.sql`, `202607100002_family_tree_neighborhood_performance.sql` і `familyTreeNeighborhoodService.ts`.
- RPC має default 400 / hard 600 canonical nodes, keyset cursor, `graphVersion`, permission fingerprint, branch validation, nondominated traversal states і server-side privacy masking.
- Direct-table RLS не віддає viewer точні рядки живих приватних осіб або зв’язків, через які ці дані можна вивести.
- Початковий RPC має defaults `ancestorDepth=7`, `descendantDepth=0`, `collateralDepth=0`: завантажуються тільки фокус і прямі предки; кожен бічний напрямок розкривається окремим continuation біля відповідної картки.
- Повний reset локальної PostgreSQL/Supabase БД застосував усі міграції; `supabase test db` — 44/44, включно зі стрес-сценарієм на 2480 осіб у межах `statement_timeout=15s`.

### Етап 4 — production UI і безпечне ввімкнення

- Завершено в `ProductionFamilyTreePage.tsx`; `FamilyTreePage.tsx` лишає старий renderer rollback-гілкою.
- Після застосування міграції новий renderer активується явним `family_tree_renderer_v2 === true`; відсутній/ще не завантажений flag fail-closed повертає старий renderer, а вимкнення flag не потребує міграції або видалення даних.
- Реалізовано окремі ancestor/descendant controls, cousins, active/all parent sets, search-as-focus, history, zoom/fit/focus/fullscreen, continuation, collapse/re-expand, відкриття чинної картки особи й чинних dialogs додавання/приєднання.
- UI defaults — `7/0/0`; нащадки та кузени є явними opt-in, а server continuation надсилає тільки напрямок і cursor натиснутої особи.
- RPC є межею loaded scope, а production layout показує весь уже завантажений граф; branch page займає лише вільні місця до hard cap 600 і не запускає глобальний base reload.
- Canvas має keyboard/screen-reader semantic list з action parity; стани позначаються текстом/ARIA, а не лише кольором.

### Етапи 5–6 — продуктивність і тести

- `npm.cmd run benchmark:family-tree` — 3/3: 10k і 100k canonical fixtures не збільшують mounted occurrence понад 400; 400-node та +100-node p95 assertions вкладаються у 120 ms на цьому runner.
- Автоматичні unit/integration/E2E-contract, lint, typecheck і build перевірки додано в `package.json`; остаточний результат команд фіксується в документації та handoff.
- Реальна in-app browser visual QA лишилася ручним пунктом: після першої невдалої спроби підключення browser surface перейшов на заблоковану службову error-URL і політика не дозволила повторну інспекцію або інший browser workaround.

### Етап 7 — rollout

- Міграція лише додає version/RPC/policies/triggers і не переносить та не видаляє родові дані.
- Rollback UI: вимкнути `family_tree_renderer_v2`; старий layout-код навмисно не видалено.
