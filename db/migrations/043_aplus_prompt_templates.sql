-- A+ v1 seed from prompt/normalized/aplus-*.md, using the normalized importer's IDs and full-file hashes.
-- Seed only new templates. Startup replays migrations and must preserve later publishes and retirements.
DO $$
DECLARE
  seed record;
  inserted_template_id uuid;
BEGIN
  FOR seed IN
    SELECT * FROM (VALUES
    (
      'aplus.ai-write', 'A+详情 · AI 帮写', 'planner', 'aplus_ai_write', 'llm',
      '58aca921-d737-52e5-abce-2104cd59a42a', 'c4a39569-9f21-5d8f-addc-8aed2ba16314',
      'prompt/normalized/aplus-ai-write.md', 'b94384bcdf7b7631fb95f35bcce077c1ba60b29b77bcb92b49c90a903e39a035',
      '[{"key":"inputImageIds","label":"商品原图对应顺序","type":"textarea","required":true,"order":0},{"key":"productInfo","label":"当前商品卖点与生成要求","type":"textarea","required":false,"order":1},{"key":"productCardFacts","label":"商品卡事实","type":"textarea","required":false,"order":2},{"key":"cardMode","label":"商品卡选择","type":"text","required":true,"order":3},{"key":"selectedModules","label":"所选模块代码","type":"textarea","required":true,"order":4},{"key":"moduleRules","label":"所选模块规则","type":"textarea","required":true,"order":5},{"key":"platform","label":"目标平台","type":"text","required":true,"order":6},{"key":"targetMarket","label":"目标市场","type":"text","required":true,"order":7},{"key":"language","label":"画面文字语言","type":"text","required":true,"order":8}]',
      '{}', '{}',
      $prompt$你是电商运营文案助手。根据同一商品的原图、用户已填写的文本和已选 A+ 模块，起草可直接回填到「商品卖点&生成要求」的文本。沿用当前表单的语言；画面文字语言只用于理解目标市场和画面约束，「不加文字」时仍要补充商品信息。

### 未选商品卡
按顺序写五段：1. 产品名称、2. 核心卖点、3. 适用人群、4. 期望场景、5. 具体参数。保留已有的可靠事实与生成要求，基于图片可确认的外观与文本补全，卖点聚焦真实价值。在五段后追加所选模块仍缺的输入，如尺寸、成分或质保政策；已在五段写过的内容不重复。

### 已选商品卡
只写「补充说明」中所选模块需要、商品卡未包含的信息。用户在当前文本中已提供的有效补充可直接保留，原图可确认的信息可补写。不要重复商品卡事实、复述五段基本信息、覆盖有冲突的商品卡事实或建议回写商品卡。无内容可补时输出空文本。

### 两种情况都适用
- 从所选模块的规则判断需要什么，不补未选模块的资料。按图中可见内容做描述，不猜测真实规格、配方、功效、认证、产地、包装清单或政策。
- 图片看不出、已有文本也没有可靠证据的必要事实，逐项写成 `【待补充：xxx】`，用具体字段名替换 xxx，例如 `【待补充：质保期限】`。已有待补充内容不作为事实。
- 只输出可回填的纯文本，不加解释、Markdown 围栏或 JSON。控制在 1000 字以内。

### 本次所选模块的规则
{{moduleRules}}$prompt$,
      $prompt$商品原图对应顺序：{{inputImageIds}}
当前商品卖点与生成要求：{{productInfo}}
商品卡选择：{{cardMode}}
商品卡事实：{{productCardFacts}}
所选模块代码：{{selectedModules}}
目标平台：{{platform}}
目标市场：{{targetMarket}}
画面文字语言：{{language}}

请按照本次商品卡选择和所选模块补写表单文本。$prompt$
    ),
    (
      'aplus.image', 'A+详情 · 图像包装指令', 'direct_generation', 'aplus_image', 'image_model',
      'db2a3afd-40aa-5e3c-ac51-24252576e14b', 'baeb5bfe-abf0-5249-b59e-1713d5a58e9a',
      'prompt/normalized/aplus-image.md', '37a704400fd643c5b6143cb9a37b7040b41941ff9739fa015b7de1563581cbfe',
      '[{"key":"moduleCode","label":"模块代码","type":"text","required":true,"order":0},{"key":"pictureRequirement","label":"画面要求","type":"textarea","required":true,"order":1},{"key":"copyRequirements","label":"文案要求","type":"textarea","required":false,"order":2},{"key":"sizeAndSafeArea","label":"尺寸与安全区","type":"textarea","required":true,"order":3},{"key":"copyMode","label":"画面文字模式","type":"text","required":true,"order":4}]',
      '{}', '{}',
      $prompt$你是电商详情页设计师。生成一张指定模块和画幅的 A+ 详情图。

- 所有输入图都是同一商品的原图，是商品外观的唯一依据。保持商品的外形、比例、结构、颜色、纹理、原有标识、按键和接口位置。不得凭空增删部件或改变商品身份。
- 按画面要求安排版式和光线，把商品主体、关键部位和文字放在中心安全区，裁切余量只用背景或非关键装饰。文字不得压住商品关键部位。
- 需要文字时，只按文案要求逐字渲染指定的文字，遵守指定语言、位置和层级。不要把标题层级、说明指令、占位符或 JSON 字段名画出来。避免错字、伪文字、重复文字和额外文案。文案为空时不添加设计文案。
- 「不加文字」时，整张图不得出现可读文字、字母、数字或伪文字。选择能避开文字的原图视角和自然遮挡，保持商品结构和材质，并用纯图版式。
- 品牌故事图（brand_story）中不得出现 Logo，包括商品或包装上的 Logo。优先用不露出标识的角度、景别和构图。不得添加水印、二维码、网址、联系方式、平台 Logo 或未经证实的商品声明。$prompt$,
      $prompt$请按下列模块指令出图：
{
  "moduleCode": {{moduleCode}},
  "画面要求": {{pictureRequirement}},
  "文案要求": {{copyRequirements}},
  "尺寸与安全区": {{sizeAndSafeArea}}
}
画面文字模式：{{copyMode}}$prompt$
    ),
    (
      'aplus.module.accessories', 'A+详情 · 配件/赠品图', 'planner', 'aplus_module_rule', 'llm',
      '65334c80-704d-53de-8f8f-38516e79afba', '5df40c69-d5f4-551c-bc4b-b7fabef11771',
      'prompt/normalized/aplus-module-accessories.md', 'e96240e2c9bb31aa37a45794b2a7774f718a3029c68e4da924396711dc615f38',
      '[{"key":"moduleCode","label":"模块代码","type":"text","required":true,"order":0}]',
      '{}', '{"moduleCode":"accessories"}',
      $prompt$### 配件/赠品图

- 模块目标：让浏览者明确实际会收到哪些物品。
- 构图：俯拍平铺本体和已确认随货的配件、赠品或说明书，留出清晰边距，把各物品和标签一一对应。
- 文案：可用包装清单作短标题。物品名称尽量用短句，数量按输入记录标注，未确认数量时省略。
- 合规：场景道具、参照物和图中未证实随货的物品不得列入清单，不虚构赠品或配件。$prompt$,
      $prompt$模块代码：{{moduleCode}}$prompt$
    ),
    (
      'aplus.module.after_sales', 'A+详情 · 售后保障图', 'planner', 'aplus_module_rule', 'llm',
      'dbbda7e6-6b68-544b-8a61-d09931bff1cb', 'fdffe26a-2f70-502f-972a-3252e74ec729',
      'prompt/normalized/aplus-module-after_sales.md', '0cab7ebd4002cc968db768afc8296e0c7cc434a6fabe88c525f92a0b2a5d2867',
      '[{"key":"moduleCode","label":"模块代码","type":"text","required":true,"order":0}]',
      '{}', '{"moduleCode":"after_sales"}',
      $prompt$### 售后保障图

- 模块目标：把输入中已明确的售后服务、质保和退换条件传达清楚。
- 构图：使用等宽服务卡片呈现最多 3–4 条已确认的政策，按尺寸横排或用网格。政策缺失时简化为商品展示，省略可能暗示担保的图标和表述。
- 文案：可用简洁的模块标题。每个有根据的政策配 2–6 字标题、最多 16 字说明，保留期限和适用条件；必要时减少卡片，确保条件完整。
- 合规：政策只能取自商品卡或用户明确填写的售后承诺。不得补入平台惯例、质保天数、退换时限、运费承诺、服务范围或「售后无忧」等未证实保证。$prompt$,
      $prompt$模块代码：{{moduleCode}}$prompt$
    ),
    (
      'aplus.module.atmosphere', 'A+详情 · 场景氛围图', 'planner', 'aplus_module_rule', 'llm',
      'cbb3ab2f-1caa-5011-a8af-66902a4918bd', 'b83f6a95-d241-559b-9174-e8064bc4dafd',
      'prompt/normalized/aplus-module-atmosphere.md', '35dd56f6cb7f95329a96a095b74fb9bd7cf494bc9c1e458fe441d1a5751824a1',
      '[{"key":"moduleCode","label":"模块代码","type":"text","required":true,"order":0}]',
      '{}', '{"moduleCode":"atmosphere"}',
      $prompt$### 场景氛围图

- 模块目标：用生活情境传递与商品匹配的感受，帮助浏览者想象商品融入日常的样子。
- 构图：用自然光、空间留白和少量与场景相符的道具营造氛围，商品仍是画面焦点。可用局部人物或无人物的构图。
- 文案：主文案是一句不超过 14 字的情绪短句，必要时加一句同语言的小字。
- 合规：氛围元素不得暗示未经验证的功能、适用环境或随商品附赠的物品。$prompt$,
      $prompt$模块代码：{{moduleCode}}$prompt$
    ),
    (
      'aplus.module.brand_story', 'A+详情 · 品牌故事图', 'planner', 'aplus_module_rule', 'llm',
      '4340bfe4-92cc-5def-8564-72dc13181237', 'c18f9d95-9390-5cf6-90cb-b83fe43ec9b4',
      'prompt/normalized/aplus-module-brand_story.md', '8c95cebf7cf6b6d22d3b5124e6a32004a22a30b96fc51d7f8862c4b9522ca22e',
      '[{"key":"moduleCode","label":"模块代码","type":"text","required":true,"order":0}]',
      '{}', '{"moduleCode":"brand_story"}',
      $prompt$### 品牌故事图

- 模块目标：传达输入已确认的品牌理念、初心或表达风格。
- 构图：用与理念一致的自然背景和柔和氛围，借原图商品及文字传达品牌。选择不露出商品和包装标识的角度，在中心安全区保留连续的文字区域。
- 文案：标题或口号不超过 12 字，正文约 40–80 字，按画幅读取难度缩短。输入缺品牌资料时，可以表达商品可见的设计气质。
- 合规：整张图不得出现 Logo，不生成品牌标识或独立品牌素材。不虚构品牌名称、历史、创始人、产地、资质或奖项。$prompt$,
      $prompt$模块代码：{{moduleCode}}$prompt$
    ),
    (
      'aplus.module.comparison', 'A+详情 · 效果对比图', 'planner', 'aplus_module_rule', 'llm',
      '1e2363cd-8627-5c8f-85bc-f1f628dc51a6', '938d6eb8-e504-5cd6-9b21-89ea487686c6',
      'prompt/normalized/aplus-module-comparison.md', '08969d9f79b9e72a30c86d2a18ee997ee04e8297ed5a2a61770d959df4eb1625',
      '[{"key":"moduleCode","label":"模块代码","type":"text","required":true,"order":0}]',
      '{}', '{"moduleCode":"comparison"}',
      $prompt$### 效果对比图

- 模块目标：用可靠的自身对比说明使用前后、新旧款或规格间的真实差异。
- 构图：用左右或上下对分，固定视角、光线和尺度，只突出一个已有依据的差异。缺少对比事实时，用商品和场景作描述性展示，不暗示未经证实的效果。
- 文案：两侧各用短标签标明对应状态，可配一句不超过 14 字的、有依据的结论。
- 合规：沿用 comparison 定义。不得出现竞品品牌、竞品商品或泛称的竞品替代物，不写「最好」「第一」等无依据比较，不夸大效果或承诺医疗功效。$prompt$,
      $prompt$模块代码：{{moduleCode}}$prompt$
    ),
    (
      'aplus.module.craftsmanship', 'A+详情 · 工艺制作图', 'planner', 'aplus_module_rule', 'llm',
      '59ae2fd1-c5d9-55ee-9821-a862d814aaf3', '7e79daa8-a35f-59a0-aab5-3a849ae24454',
      'prompt/normalized/aplus-module-craftsmanship.md', '8cdc2e8a7d659c1259ee78d617269cfb7e452acbd2c67222037e1cd44feb1bac',
      '[{"key":"moduleCode","label":"模块代码","type":"text","required":true,"order":0}]',
      '{}', '{"moduleCode":"craftsmanship"}',
      $prompt$### 工艺制作图

- 模块目标：把有资料支撑的选材、加工或制作过程讲清楚。
- 构图：将已有证据的工艺环节做成时间轴或 3–4 格流程图，保持每格构图统一。输入只支持成品细节时，集中展示有依据的材质与细节。
- 文案：短标题，每个已确认环节配 2–6 字步骤名及不超过 16 字的说明。
- 合规：不能用行业通用流程替代本商品的事实，不假造工厂、质检流程、资质或特殊工艺。$prompt$,
      $prompt$模块代码：{{moduleCode}}$prompt$
    ),
    (
      'aplus.module.detail_closeup', 'A+详情 · 商品细节图', 'planner', 'aplus_module_rule', 'llm',
      '0f153116-c762-5338-b26d-2c7646ec635b', '33a6d670-25a7-5d77-a1dd-46b7df0f7355',
      'prompt/normalized/aplus-module-detail_closeup.md', '800ac93e0956b71e881f5ae60a01bad73621f749c4e6c1159b1281be8a9c09d3',
      '[{"key":"moduleCode","label":"模块代码","type":"text","required":true,"order":0}]',
      '{}', '{"moduleCode":"detail_closeup"}',
      $prompt$### 商品细节图

- 模块目标：用实物细节表现材质质感、结构和工艺可见特征。
- 构图：选择 2–4 个有原图依据的细节，如走线、按键或纹理。用整体商品配放大窗、细引线，或在一张图内排成微距特写网格。
- 文案：每个细节配 4–8 字标题和不超过 16 字说明，数量按原图能支持的细节调整。
- 合规：结构与纹理需能在原图对应到真实部位。材质名称、加工方式、等级等事实必须有输入根据。$prompt$,
      $prompt$模块代码：{{moduleCode}}$prompt$
    ),
    (
      'aplus.module.hero', 'A+详情 · 首屏主视觉', 'planner', 'aplus_module_rule', 'llm',
      'b801ba29-2963-52c7-b3ab-0ffc98693f4d', '06e2d0a3-e82a-5048-b5f4-c2153beac7f8',
      'prompt/normalized/aplus-module-hero.md', 'b23590a3140747d2ab88dfc5b022abe28c5b485fdb8f8dc85b36119d140a532e',
      '[{"key":"moduleCode","label":"模块代码","type":"text","required":true,"order":0}]',
      '{}', '{"moduleCode":"hero"}',
      $prompt$### 首屏主视觉

- 模块目标：传递核心价值，让浏览者很快看出商品是什么、适合解决什么需求。
- 构图：用单一焦点呈现完整商品，约占画面 40–60%，用柔和轮廓光、简洁台面或与品类匹配的背景强调质感，在中心安全区内安排标题留白。
- 文案：主标题 4–10 字，副标题 10–20 字，围绕一个核心价值。可选一个简短角标，仅使用输入已确认的信息。
- 合规：不堆砌卖点或夸大功效，不添加无依据的数据、新品标识或促销承诺。$prompt$,
      $prompt$模块代码：{{moduleCode}}$prompt$
    ),
    (
      'aplus.module.ingredients', 'A+详情 · 商品成分图', 'planner', 'aplus_module_rule', 'llm',
      'b43d9316-ac51-5d04-aa97-47fd21403883', '8d8e0fa0-035b-5f4c-aa54-dd6298d45742',
      'prompt/normalized/aplus-module-ingredients.md', '90e705ea87e1149385cb776b647af256b402ccef4a7265c2c1f3fd0f16c7e956',
      '[{"key":"moduleCode","label":"模块代码","type":"text","required":true,"order":0}]',
      '{}', '{"moduleCode":"ingredients"}',
      $prompt$### 商品成分图

- 模块目标：帮助浏览者认识商品已有事实支持的主要配方、原料或材质。
- 构图：可用已确认的原料实物、材质切面或商品局部加引线呈现成分，避免过多装饰造成成分联想。
- 文案：短标题配 2–4 项成分名称和不超过 14 字的特性说明。只有一项事实时按实呈现。
- 合规：成分、含量和认证必须有输入根据，不从外观推断配方，不对化妆品、食品、保健商品做医疗或夸大功效承诺。$prompt$,
      $prompt$模块代码：{{moduleCode}}$prompt$
    ),
    (
      'aplus.module.multi_angle', 'A+详情 · 多角度图', 'planner', 'aplus_module_rule', 'llm',
      'b99321ad-e2c6-54cf-a57a-27dec5a086e7', 'a2f26fa8-46e9-51b4-ada1-a45406f0d20f',
      'prompt/normalized/aplus-module-multi_angle.md', 'ab9940e667db213e0d5018357d3c07a9878008673ea8cc46f1d331d07dc49c1d',
      '[{"key":"moduleCode","label":"模块代码","type":"text","required":true,"order":0}]',
      '{}', '{"moduleCode":"multi_angle"}',
      $prompt$### 多角度图

- 模块目标：在单张图中展示同一商品的多个可确认视角。
- 构图：用同尺度的网格或等距横排呈现正面、侧面、背面、顶部或斜视。优先选 3–4 个原图支持的视角，素材不足时减少视角，统一棚拍光线和阴影。
- 文案：简短模块标题，每个视角配 2–4 字标签，可用细线标注已知部位。
- 合规：不补造原图看不到的接口、按键或结构。未覆盖完整视角时不写全景或 360°。$prompt$,
      $prompt$模块代码：{{moduleCode}}$prompt$
    ),
    (
      'aplus.module.selling_points', 'A+详情 · 核心卖点图', 'planner', 'aplus_module_rule', 'llm',
      '122af5ad-a0f5-5efa-b8c5-71f4c5112291', '7e26b0cc-caf1-50de-874f-2601d08c5b62',
      'prompt/normalized/aplus-module-selling_points.md', '95696420bcd4725e4884d367569d3921c2469aaf07a120345ca4ca632ad3019e',
      '[{"key":"moduleCode","label":"模块代码","type":"text","required":true,"order":0}]',
      '{}', '{"moduleCode":"selling_points"}',
      $prompt$### 核心卖点图

- 模块目标：帮助浏览者快速理解可靠的商品差异和使用价值。
- 构图：用商品配环绕卡片、两栏布局或 3–4 格短卡呈现，每条搭配直接相关的细节图或简洁图标，商品和信息互不遮挡。
- 文案：选 3–4 条已确认卖点，事实较少时缩减条数。每条短标题 4–8 字、说明不超过 16 字，可强调已核实的数值和单位。
- 合规：不重复首屏同一句标题，不用图标暗示认证或功能，不虚构容量、续航、功率或功效。$prompt$,
      $prompt$模块代码：{{moduleCode}}$prompt$
    ),
    (
      'aplus.module.series', 'A+详情 · 系列展示图', 'planner', 'aplus_module_rule', 'llm',
      'e01aae50-1cf3-59ca-9c38-b2d31e84cf44', 'c2fa2d5f-a642-5749-89bc-0a024ae2476f',
      'prompt/normalized/aplus-module-series.md', '784f6882a759421164c65f3b244e1e2de241de277072a462ec9e16b059a064fe',
      '[{"key":"moduleCode","label":"模块代码","type":"text","required":true,"order":0}]',
      '{}', '{"moduleCode":"series"}',
      $prompt$### 系列展示图

- 模块目标：在一张图中展示已确认的同款颜色、规格或 SKU。
- 构图：用对齐并排或阶梯式布局突出真实变体。有相应原图时呈现商品外观，只有已确认的名称或颜色资料时用标签、色样说明。
- 文案：短标题，各款下配准确的颜色、规格名或 SKU。没有已确认的变体时，只描述当前商品。
- 合规：不凭空改变商品外观、增加在售款式，不能把参考中的摆件当成同系列商品。$prompt$,
      $prompt$模块代码：{{moduleCode}}$prompt$
    ),
    (
      'aplus.module.size_spec', 'A+详情 · 尺寸/容量/尺码图', 'planner', 'aplus_module_rule', 'llm',
      'c7b308c0-50c6-5193-8d4a-642f29eefa96', '4eaa920e-bb5d-56a8-a81f-a76e6605a43f',
      'prompt/normalized/aplus-module-size_spec.md', '65647eb432a95d1f5aa3503038a98ad9e4df370f51112e4be08bec1a4e3dcf4c',
      '[{"key":"moduleCode","label":"模块代码","type":"text","required":true,"order":0}]',
      '{}', '{"moduleCode":"size_spec"}',
      $prompt$### 尺寸/容量/尺码图

- 模块目标：直观说明已确认的商品量度，帮助用户判断是否合适。
- 构图：按品类采用正侧视图配尺寸线、容量示意或服饰尺码表，数值与标注一一对应，避免把没有比例依据的道具画成尺度参照。
- 文案：短标题加尺寸、容量或尺码标签。每个数值保留输入单位，缺失时省去数值或只展示部位。
- 合规：不依据照片猜测尺寸、容量、尺码或重量，不添加未提供的误差、换算或适配范围。$prompt$,
      $prompt$模块代码：{{moduleCode}}$prompt$
    ),
    (
      'aplus.module.spec_table', 'A+详情 · 详细规格/参数表', 'planner', 'aplus_module_rule', 'llm',
      'b4f87209-3f19-5682-9831-8d9876a127b2', '176ac086-6ab0-50d2-a51d-66ae908ac60d',
      'prompt/normalized/aplus-module-spec_table.md', '4b3f4f918b277d34cdf848d2233c5a1534628429da16cc7cba434251d44c367a',
      '[{"key":"moduleCode","label":"模块代码","type":"text","required":true,"order":0}]',
      '{}', '{"moduleCode":"spec_table"}',
      $prompt$### 详细规格/参数表

- 模块目标：按条传递已确认的商品规格，方便快速查找和核对。
- 构图：用简洁商品图和两列表格，按画幅左右或上下分区，统一行距和对齐，给文字留出足够空间。
- 文案：短标题及最多 8 行「参数名：参数值」。参数齐全时优先选最相关的 5–8 行，保留原单位，无值的行省略。
- 合规：不根据品类补猜参数，不添加空行、虚构认证或规格，也不把待补充占位画出来。$prompt$,
      $prompt$模块代码：{{moduleCode}}$prompt$
    ),
    (
      'aplus.module.usage_scene', 'A+详情 · 使用场景图', 'planner', 'aplus_module_rule', 'llm',
      'c98d4523-8ab5-5e0c-939f-441127ba4b69', '069c302d-6f71-51de-bf5e-b12909cebf1c',
      'prompt/normalized/aplus-module-usage_scene.md', '3bf88a93cc2eec0fa6f65480c1d1aa398ad363e9c00088146146709fba069373',
      '[{"key":"moduleCode","label":"模块代码","type":"text","required":true,"order":0}]',
      '{}', '{"moduleCode":"usage_scene"}',
      $prompt$### 使用场景图

- 模块目标：展示目标人群在真实情境中如何拿取、穿戴或操作商品。
- 构图：用满幅单场景或 2–3 个分栏，交代人物的动作与商品的关系，结合目标市场安排自然的道具和光线，保证商品清晰。
- 文案：每个场景可配 4–8 字标题和不超过 16 字的一句说明，必要时加简短总标题。
- 合规：只演示符合证据的用途，避免危险用法、未经证实的适配和夸大的使用结果。$prompt$,
      $prompt$模块代码：{{moduleCode}}$prompt$
    ),
    (
      'aplus.module.usage_tips', 'A+详情 · 使用建议图', 'planner', 'aplus_module_rule', 'llm',
      'fadc089d-5282-55a7-a116-eb15ebea0f7e', '862bfbc7-68d4-54fa-89ec-43dfcd48f6d4',
      'prompt/normalized/aplus-module-usage_tips.md', 'e70493cc8d0f7493fe115a9e8872ee62c762c07ea206be52e9e3052f65324c55',
      '[{"key":"moduleCode","label":"模块代码","type":"text","required":true,"order":0}]',
      '{}', '{"moduleCode":"usage_tips"}',
      $prompt$### 使用建议图

- 模块目标：让浏览者看懂商品的使用方法与已有提示。
- 构图：用一张图中的步骤卡片或 2×2 格表现实际操作，每格集中展示一个动作，按原图参照商品结构和手部接触位置。
- 文案：约 3–4 步或注意事项，每项标题 2–8 字，说明不超过 18 字，步骤按真实顺序。已确认内容不足时减少条数。
- 合规：只写有依据且安全的操作和维护事项，不编造警示、工作温度或未经确认的操作步骤。$prompt$,
      $prompt$模块代码：{{moduleCode}}$prompt$
    ),
    (
      'aplus.plan', 'A+详情 · 方案规划', 'planner', 'aplus_plan', 'llm',
      'f26d914a-1cf5-5f58-bb70-0aaf2bb961ee', 'f9ae4de5-4f17-5e30-8146-f2d6b417225f',
      'prompt/normalized/aplus-plan.md', '4c7e7e08234331122c4011afa1dc79e22a3b96f020919cdb70ebd825d31174d5',
      '[{"key":"inputImageIds","label":"商品原图缩略图顺序","type":"textarea","required":true,"order":0},{"key":"productInfo","label":"商品卖点与生成要求","type":"textarea","required":false,"order":1},{"key":"productCardFacts","label":"商品卡快照事实","type":"textarea","required":false,"order":2},{"key":"platform","label":"目标平台","type":"text","required":true,"order":3},{"key":"targetMarket","label":"目标市场","type":"text","required":true,"order":4},{"key":"language","label":"输出语言","type":"text","required":true,"order":5},{"key":"listingCopyRules","label":"平台上架文案规则","type":"textarea","required":false,"order":6},{"key":"selectedModules","label":"所选模块代码","type":"textarea","required":true,"order":7},{"key":"moduleRules","label":"所选模块规则","type":"textarea","required":true,"order":8},{"key":"sizePresets","label":"本次选中的详情尺寸预设","type":"textarea","required":true,"order":9},{"key":"copyMode","label":"画面文字模式","type":"text","required":true,"order":10},{"key":"layoutMode","label":"构图规划方式","type":"text","required":true,"order":11}]',
      '{"type":"object","additionalProperties":false,"required":["schemaVersion","taskName","globalPlan","modules"],"properties":{"schemaVersion":{"const":"aplus-plan-v1"},"taskName":{"type":"string","maxLength":20},"globalPlan":{"type":"string","minLength":1},"modules":{"type":"array","minItems":1,"maxItems":10,"items":{"type":"object","additionalProperties":false,"required":["moduleCode","copyRequirements","imagePrompts"],"properties":{"moduleCode":{"type":"string"},"copyRequirements":{"type":"string"},"imagePrompts":{"type":"object","minProperties":1,"maxProperties":2,"additionalProperties":{"type":"string","minLength":1}}}}}}}', '{}',
      $prompt$你是电商详情页策划和视觉设计总监。请根据同一商品的原图缩略图、商品卖点与生成要求、可选商品卡快照和本次配置，为所选 A+ 模块制定可以逐张出图的统一方案。

### 商品事实与平台限制
- 商品名称、规格、参数、数字、功效、认证、配件和售后政策只能来自商品卡快照、用户填写的商品事实或原图可辨识内容。售后保障图的政策必须由商品卡或用户明确提供。以商品卡快照优先处理冲突。
- `【待补充】`、`【待补充：…】` 等未填占位都视为缺失。事实缺失时省略具体声明，使用可见外观或场景的描述性文案。不得把占位、无依据数字或暗示功效的画面放入出图要求。
- 遵守输入的上架文案规则和禁用词。场景适合目标市场。避免绝对化或夸大宣传、竞品、虚构认证、价格促销、平台 Logo、网址、联系方式和二维码。
- 商品外形、结构、材质、颜色以商品原图为准。模块画面使用照片中能确认的角度和部位，注明主要参考第几张原图。

### 规划方式
- globalPlan 写清核心价值、目标人群、叙事顺序和统一视觉风格，包括配色、字体气质、背景和光线。各模块承担各自职责，减少重复卖点和版式。
- copyRequirements 用字符串列出逐字渲染的标题、短句等，并注明文案层级和大致位置。只写指定语言的可见文案。中文按模块字数控制，英文按短标题、短句调整篇幅。当 language 为 `none` 或画面文字模式为「不加文字」时，每个模块的 copyRequirements 必须是空字符串 `""`。画面要求同时明确整张图无可读文字、字母、数字或伪文字，并按纯图排版。
- 每条 imagePrompts 画面要求独立写明版式、主体位置和占比、参考图序号、背景、光影、装饰和文字区（如有）。重点商品、关键细节和文字集中在中心安全区，边缘只留背景或非关键装饰，给居中裁切留余量。
- 只为输入中选中的预设 key 提供画面要求。高级 A+ Web 端和移动端同时选中时，逐模块分别为 `aplus_premium_web` 和 `aplus_premium_mobile` 写独立完整的构图。Web 横幅可用左右铺陈，移动端按较窄画幅重新分区和安排留白。每个模块两端共用同一份 copyRequirements。

### 本次所选模块的规则
{{moduleRules}}

### 输出
只输出一个合法的 `aplus-plan-v1` JSON 对象，不带 Markdown 围栏或解释。顶层包含 schemaVersion、taskName、globalPlan、modules。taskName 最多 20 字，不确定时用空字符串。modules 按所选模块顺序逐一输出，每项包含 moduleCode（原样回传）、copyRequirements、imagePrompts。imagePrompts 是以所选预设的 key 为键、完整画面要求字符串为值的对象。$prompt$,
      $prompt$商品原图缩略图对应顺序：{{inputImageIds}}
商品卖点与生成要求：{{productInfo}}
商品卡快照事实：{{productCardFacts}}
目标平台：{{platform}}
目标市场：{{targetMarket}}
输出语言：{{language}}
平台上架文案规则：{{listingCopyRules}}
所选模块代码（按此顺序输出）：{{selectedModules}}
所选详情尺寸预设：{{sizePresets}}
画面文字模式：{{copyMode}}
构图规划方式：{{layoutMode}}

请结合附带的商品原图缩略图和系统中的所选模块规则，输出 aplus-plan-v1。$prompt$
    )
    ) AS templates(code, name, kind, stage, execution_target, template_id, version_id, source_file,
      source_sha256, input_schema, output_schema, applicability, body, user_prompt_template)
  LOOP
    INSERT INTO prompt_library.prompt_templates (id, code, name, kind, stage, execution_target)
    VALUES (seed.template_id::uuid, seed.code, seed.name, seed.kind, seed.stage, seed.execution_target)
    ON CONFLICT (code) DO NOTHING
    RETURNING id INTO inserted_template_id;

    IF inserted_template_id IS NOT NULL THEN
      INSERT INTO prompt_library.prompt_template_versions
        (id, template_id, version_no, name, kind, stage, execution_target, input_schema, output_schema,
         applicability, body, user_prompt_template, status, source_file, source_heading, source_sha256, published_at)
      VALUES
        (seed.version_id::uuid, inserted_template_id, 1, seed.name, seed.kind, seed.stage, seed.execution_target,
         seed.input_schema::jsonb, seed.output_schema::jsonb, seed.applicability::jsonb, seed.body, seed.user_prompt_template,
         'published', seed.source_file, seed.name, seed.source_sha256, now());

      UPDATE prompt_library.prompt_templates
      SET published_version_id = seed.version_id::uuid
      WHERE id = inserted_template_id;
    END IF;
  END LOOP;
END $$;
