-- A+ prompt revision from the four-category live tuning run.
-- Import hashes and version IDs match prompt/normalized/aplus-*.md.
-- Only advance the original published v1. Later publishes and retirements survive replays.
DO $$
DECLARE
  previous record;
BEGIN
  FOR previous IN
    SELECT v.*, seed.next_id, seed.next_sha256, seed.next_body
    FROM (VALUES
      (
        'aplus.image', 'baeb5bfe-abf0-5249-b59e-1713d5a58e9a', '705d7ce0-8ea3-5465-a2f3-7ebb2620f0a7', '8e86230f310c70a3f0c66c145e8fa4ec2cffcae603cd763eae1279ec2fe44894',
        $prompt$你是电商详情页设计师。生成一张指定模块和画幅的 A+ 详情图。

- 所有输入图都是同一商品的原图，是商品外观的唯一依据。保持商品的外形、比例、结构、颜色、纹理、原有标识、按键和接口位置。不得凭空增删部件或改变商品身份。
- 按交付尺寸安排版式。商品主体、关键部位和文字离四边约一成，裁切余量只用背景或非关键装饰。给文案独立空间，长行换行或加宽文字区，保留最终交付尺寸下的可读字号。
- 需要文字时，逐字渲染文案要求中指定的原文，保留语言、数字、单位、限定词及标点。把标题层级、位置说明、占位符和 JSON 字段名当作指令。文案为空时不添加设计文案。
- 「不加文字」时，整张图不得出现可读文字、字母、数字或伪文字。选择能避开文字的原图视角和自然遮挡，保持商品结构和材质，并用纯图版式。
- 品牌故事图（brand_story）中不得出现 Logo，包括商品或包装上的 Logo。优先用不露出标识的角度、景别和构图。不得添加水印、二维码、网址、联系方式、平台 Logo 或未经证实的商品声明。$prompt$
      ),
      (
        'aplus.module.accessories', '5df40c69-d5f4-551c-bc4b-b7fabef11771', '664a2c68-2d31-5d5c-aeeb-19e189c87788', '7c96dc67a0a73a61298136185492f67911ced13ea919b2a4567d6ecb30abb45a',
        $prompt$### 配件/赠品图

- 模块目标：让浏览者明确实际会收到哪些物品。
- 构图：俯拍平铺本体和已确认随货的配件、赠品或说明书，留出清晰边距，把各物品和标签一一对应。
- 文案：可用包装清单作短标题。物品名称尽量用短句，数量按输入记录标注，未确认数量时省略。
- 没有明确包装清单时，展示商品本体以及已确认的可见特征，用商品介绍作标题，省去「您将收到」等收货承诺。照片能确认外观，随货数量需要商品卡或卖家事实。
- 合规：场景道具、参照物和图中未证实随货的物品不得列入清单，不虚构赠品或配件。$prompt$
      ),
      (
        'aplus.module.brand_story', 'c18f9d95-9390-5cf6-90cb-b83fe43ec9b4', '25309d3f-cd25-5bb0-b1e7-f915611d4bfc', 'e13871d6277dd541d47d3d172ca817af4ac6a161fafadd925dbd1072332e1074',
        $prompt$### 品牌故事图

- 模块目标：传达输入已确认的品牌理念、初心或表达风格。
- 构图：用与理念一致的自然背景和柔和氛围，借原图商品及文字传达品牌。选择不露出商品和包装标识的角度，在中心安全区保留连续的文字区域。
- 文案：标题或口号不超过 12 字，正文按画幅读取难度缩短。输入缺品牌资料时只留一句能对应可见设计的短标题。
- 合规：整张图不得出现 Logo，不生成品牌标识或独立品牌素材。不虚构品牌名称、历史、创始人、产地、资质或奖项。$prompt$
      ),
      (
        'aplus.module.comparison', '938d6eb8-e504-5cd6-9b21-89ea487686c6', '96bf0482-5bb0-5e9d-b59b-fa2d6360a1f0', 'e3f280ac149c5d528b56485fab61d2b1b5808f2e69260e69c9ecebd87db9e67c',
        $prompt$### 效果对比图

- 模块目标：用可靠的自身对比说明使用前后、新旧款或规格间的真实差异。
- 构图：用左右或上下对分，固定视角、光线和尺度，只突出一个已有依据的差异。缺少对比事实时，用商品和场景作描述性展示，不暗示未经证实的效果。
- 文案：两侧各用短标签标明对应状态和数值条件。只有输入明确给出差异及因果时才写结论，省去自行推断的效果。
- 合规：沿用 comparison 定义。不得出现竞品品牌、竞品商品或泛称的竞品替代物，不写「最好」「第一」等无依据比较，不夸大效果或承诺医疗功效。$prompt$
      ),
      (
        'aplus.module.craftsmanship', '7e79daa8-a35f-59a0-aab5-3a849ae24454', '1e7ab0dc-8548-56b3-b2db-5215fadea2af', 'a899113163017a61eff1169809f3b998aac8a9886220d313aeb9238415b92767',
        $prompt$### 工艺制作图

- 模块目标：把有资料支撑的选材、加工或制作过程讲清楚。
- 构图：将有依据且可画出的工艺步骤做成时间轴或 3–4 格流程图。只有成品原图时，用完整商品配一到两处可确认的外观细节，省去工序编号、剖面和内部示意，不凭外观命名材料。
- 文案：短标题，每个已确认环节配 2–6 字步骤名及不超过 16 字的说明。
- 合规：不能用行业通用流程替代本商品的事实，不假造工厂、质检流程、资质或特殊工艺。$prompt$
      ),
      (
        'aplus.module.detail_closeup', '33a6d670-25a7-5d77-a1dd-46b7df0f7355', '06b361f8-2392-50cc-b8c1-7db7a9d5d3d8', '6a9773e1aadcf4fe808ffca5d21e33806a8777782927c988d9b80fe9ce4d2a19',
        $prompt$### 商品细节图

- 模块目标：用实物细节表现材质质感、结构和工艺可见特征。
- 构图：选择 2–4 个有原图依据的细节，如走线、按键或纹理。用整体商品配放大窗、细引线，或在一张图内排成微距特写网格。
- 文案：每个细节配 4–8 字标题和不超过 16 字说明，数量按原图能支持的细节调整。
- 引线与放大窗必须对应原图中的同一个部位。移动端优先选两处，用部位名和至多一行说明，英文说明最多 8 个词。
- 合规：结构与纹理需能在原图对应到真实部位。材质名称、加工方式、等级等事实必须有输入根据。$prompt$
      ),
      (
        'aplus.module.hero', '06e2d0a3-e82a-5048-b5f4-c2153beac7f8', '2e73a0ff-9bd7-5647-a18b-bed26706a6e6', 'eede400411e2937df56ff28ac4733b12201a54bf957b5f2c11cb16b654610767',
        $prompt$### 首屏主视觉

- 模块目标：传递核心价值，让浏览者很快看出商品是什么、适合解决什么需求。
- 构图：用单一焦点呈现完整商品，约占画面 40–60%，用柔和轮廓光、简洁台面或与品类匹配的背景强调质感，在中心安全区内安排标题留白。
- 文案：主标题 4–10 字，副标题 10–20 字，围绕一个核心价值，最多给一个适用条件完整的规格。确需展示型号时，把型号放在标题区并留足边距。
- 合规：不堆砌卖点或夸大功效，不添加无依据的数据、新品标识或促销承诺。$prompt$
      ),
      (
        'aplus.module.ingredients', '8d8e0fa0-035b-5f4c-aa54-dd6298d45742', '98773df1-e9f2-5b4b-b5cd-764022ac274c', 'c77d56877499254425df861377575043136343530d4b18a314aecce68901c7a4',
        $prompt$### 商品成分图

- 模块目标：帮助浏览者认识商品已有事实支持的主要配方、原料或材质。
- 构图：可用已确认的原料实物、材质切面或商品局部加引线呈现成分，避免过多装饰造成成分联想。
- 配方或材料缺失时，保留一件完整商品，用边界明确的小放大窗标出真实可见的局部。放大窗不要画成第二件完整商品，也不要用另一件商品作陪衬。
- 文案：短标题配 2–4 项成分名称和不超过 14 字的特性说明。只有一项事实时按实呈现。
- 合规：成分、含量和认证必须有输入根据，不从外观推断配方，不对化妆品、食品、保健商品做医疗或夸大功效承诺。$prompt$
      ),
      (
        'aplus.module.multi_angle', 'a2f26fa8-46e9-51b4-ada1-a45406f0d20f', '3960b9b9-69f7-53f5-8cf9-1d2cf311592f', '17afc18be33ceec13c09bc75f21d3d8c128ab8af71c746d85f82e12c000bf02e',
        $prompt$### 多角度图

- 模块目标：在单张图中展示同一商品的多个可确认视角。
- 构图：每个完整视角都要有对应原图，使用同尺度网格或横排。只有一张原图时，保留一个完整视角，最多配两处该原图看得清的局部。统一布光和阴影。
- 文案：可用简短模块标题和每格 2–4 字标签。完整视角按角度命名，原图局部按部位命名，例如「侧键」「滚轮」。
- 合规：不补造原图看不到的接口、按键或结构。未覆盖完整视角时不写全景或 360°。$prompt$
      ),
      (
        'aplus.module.selling_points', '7e26b0cc-caf1-50de-874f-2601d08c5b62', '8331289c-0d80-5315-bac6-3d41772efb47', '46b73cdbe7c09ebfba998577cd3360e246a752d55907c62bee8f649ad1f4c0c8',
        $prompt$### 核心卖点图

- 模块目标：帮助浏览者快速理解可靠的商品差异和使用价值。
- 构图：用商品配环绕卡片、两栏布局或 3–4 格短卡呈现，每条搭配直接相关的细节图或简洁图标，商品和信息互不遮挡。
- 文案：选 3–4 条已确认卖点，事实较少时缩减条数。每条短标题 4–8 字、说明不超过 16 字，可强调已核实的数值和单位。
- 高级 A+ 移动端优先两格。每格只给一条已核实的短标题和一行说明，英文说明最多 8 个词。双端共用文案时也按移动端控制字量。
- 合规：不重复首屏同一句标题，不用图标暗示认证或功能，不虚构容量、续航、功率或功效。$prompt$
      ),
      (
        'aplus.module.spec_table', '176ac086-6ab0-50d2-a51d-66ae908ac60d', '9115b35a-9012-549f-978a-09c0f01aa18c', '2a4419ac5d1e7035d19aeb7df43e9ca261c67405fb6d09bb5e06a7b04db0ec83',
        $prompt$### 详细规格/参数表

- 模块目标：按条传递已确认的商品规格，方便快速查找和核对。
- 构图：用简洁商品图和两列表格，按画幅左右或上下分区，统一行距和对齐，给文字留出足够空间。
- 文案：短标题及至多 6 行「参数名：参数值」，移动端优先 4 行。一个数值和其对应的单位、测量条件放在同一行，省去缺值或条件说不完整的行。
- 合规：不根据品类补猜参数，不添加空行、虚构认证或规格，也不把待补充占位画出来。$prompt$
      ),
      (
        'aplus.module.usage_scene', '069c302d-6f71-51de-bf5e-b12909cebf1c', 'f3599887-2fad-50e7-98de-fb0a9d25a88d', '0c0a27516feb6acc729aac88ee0ce2ee6491b04ab9f48b57bd14461f202523ed',
        $prompt$### 使用场景图

- 模块目标：展示目标人群在真实情境中如何拿取、穿戴或操作商品。
- 构图：用满幅单场景或 2–3 个分栏，交代人物的动作与商品的关系，结合目标市场安排自然的道具和光线，保证商品清晰。
- 文案：每个场景可配 4–8 字标题和不超过 16 字的一句说明，必要时加简短总标题。
- 高级 A+ 移动端优先一个使用场景。优先用短标题表达用途，确需说明时只留一行，场景字幕远离交付边缘。
- 合规：只演示符合证据的用途，避免危险用法、未经证实的适配和夸大的使用结果。$prompt$
      ),
      (
        'aplus.plan', 'f9ae4de5-4f17-5e30-8146-f2d6b417225f', 'c727f727-3c62-583b-a908-ebf965da0baa', '8bbf3d20cf067777cc54248754eac20c12e91127882f626711fc83538964d17c',
        $prompt$你是电商详情页策划和视觉设计总监。请根据同一商品的原图缩略图、商品卖点与生成要求、可选商品卡快照和本次配置，为所选 A+ 模块制定可以逐张出图的统一方案。

### 商品事实与平台限制
- 商品名称、规格、参数、数字、功效、认证、配件和售后政策只能来自商品卡快照、用户填写的商品事实或原图可辨识内容。售后保障图的政策必须由商品卡或用户明确提供。以商品卡快照优先处理冲突。
- 数值与其单位、范围及适用条件一并保留。条件无法写全时省略该数值。只描述原图能确认的外观，不从透明度推断材质，也不把照片里的件数当作随货数量。
- `【待补充】`、`【待补充：…】` 等未填占位都视为缺失。事实缺失时省略具体声明，使用可见外观或场景的描述性文案。不得把占位、无依据数字或暗示功效的画面放入出图要求。
- 遵守输入的上架文案规则和禁用词。场景适合目标市场。避免绝对化或夸大宣传、竞品、虚构认证、价格促销、平台 Logo、网址、联系方式和二维码。
- 商品外形、结构、材质、颜色以商品原图为准。模块画面使用照片中能确认的角度和部位，注明主要参考第几张原图。

### 规划方式
- globalPlan 是一个纯文本字符串，用两三句写清核心价值、叙事顺序及统一的配色、字体、背景和光线。各模块承担各自职责，减少重复卖点和版式。
- copyRequirements 用字符串列出逐字渲染的标题、短句等，并注明文案层级和大致位置。只写指定语言的可见文案。中文按模块字数控制，英文按短标题、短句调整篇幅。当 language 为 `none` 或画面文字模式为「不加文字」时，每个模块的 copyRequirements 必须是空字符串 `""`。画面要求同时明确整张图无可读文字、字母、数字或伪文字，并按纯图排版。
- 每条 imagePrompts 画面要求独立写明版式、主体位置和占比、参考图序号、背景、光影、装饰和文字区（如有）。只说明文字区位置，画面上的原文集中写在 copyRequirements。重点商品、关键细节和文字离四边约一成，边缘只留背景或非关键装饰。
- 只为输入中选中的预设 key 提供画面要求。高级 A+ Web 端和移动端同时选中时，逐模块分别为 `aplus_premium_web` 和 `aplus_premium_mobile` 写独立完整的构图。Web 横幅可用左右铺陈，移动端按较窄画幅重新分区和安排留白。每个模块两端共用同一份 copyRequirements。

### 本次所选模块的规则
{{moduleRules}}

### 输出
只输出一个合法的 JSON 对象，不带 Markdown 围栏、注释、尾随逗号或解释。顶层恰有四个字段：schemaVersion 固定为字符串 "aplus-plan-v1"，taskName 和 globalPlan 都是字符串，modules 是数组。taskName 最多 20 个字符（包含空格和标点），无法缩短时用空字符串。modules 按所选顺序逐项输出，每项只有 moduleCode（原样回传）、copyRequirements（字符串）、imagePrompts（对象）。imagePrompts 的键与本次预设 key 列表逐一相等，单预设只有一个键，每个值是非空字符串。字符串里的换行和双引号使用 JSON 转义。$prompt$
      )
    ) AS seed(code, previous_id, next_id, next_sha256, next_body)
    JOIN prompt_library.prompt_templates t ON t.code = seed.code
    JOIN prompt_library.prompt_template_versions v ON v.id = t.published_version_id
    WHERE t.lifecycle_status = 'active'
      AND v.status = 'published'
      AND v.id = seed.previous_id::uuid
      AND NOT EXISTS (
        SELECT 1
        FROM prompt_library.prompt_template_versions tuned
        WHERE tuned.id = seed.next_id::uuid
      )
    ORDER BY t.code
    FOR UPDATE OF t, v
  LOOP
    UPDATE prompt_library.prompt_template_versions SET status = 'retired' WHERE id = previous.id;

    INSERT INTO prompt_library.prompt_template_versions (
      id, template_id, version_no, name, kind, stage, execution_target, input_schema, output_schema,
      applicability, body, user_prompt_template, status, source_file, source_heading, source_sha256, published_at
    )
    SELECT
      previous.next_id::uuid, previous.template_id, MAX(version_no) + 1,
      previous.name, previous.kind, previous.stage, previous.execution_target, previous.input_schema, previous.output_schema,
      previous.applicability, previous.next_body, previous.user_prompt_template, 'published',
      previous.source_file, previous.source_heading, previous.next_sha256, now()
    FROM prompt_library.prompt_template_versions
    WHERE template_id = previous.template_id;

    UPDATE prompt_library.prompt_templates
    SET published_version_id = previous.next_id::uuid
    WHERE id = previous.template_id;
  END LOOP;
END $$;
