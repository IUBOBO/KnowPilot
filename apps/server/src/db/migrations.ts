/**
 * 数据库迁移定义。
 *
 * 规则（违反会导致生产库不可升级，务必遵守）：
 *   1. 【只追加，不修改】已经发布出去的迁移，一个字都不能改。
 *      要改结构就追加一条新迁移。
 *   2. 每条迁移的 sql 会被算 sha256 存进 schema_migrations。
 *      有人偷偷改了已应用的迁移，启动时会因校验和不符而拒绝启动 —— 这是故意的。
 *   3. 迁移在单个事务里执行；sql 里【不要】写 BEGIN/COMMIT，也不要写
 *      PRAGMA（如 journal_mode），那些由 db/index.ts 在事务外统一处理。
 */

export interface Migration {
  /** 递增整数，从 1 开始，不允许跳号或复用 */
  version: number;
  /** 简短英文标识，用于日志与排障 */
  name: string;
  /** 该版本的 DDL/DML。多条语句用分号分隔。 */
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init-core',
    sql: `
      -- 用户。group_id 现在不用，但预留：决策里"后续按课题组数据隔离"要靠它，
      -- 现在留空列的成本是 0，事后加列要重建表并搬迁数据。
      CREATE TABLE users (
        id            TEXT    PRIMARY KEY,
        username      TEXT    NOT NULL UNIQUE,
        display_name  TEXT    NOT NULL,
        password_hash TEXT    NOT NULL,
        role          TEXT    NOT NULL CHECK (role IN ('admin','mentor','member')),
        group_id      TEXT,
        status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
        created_at    TEXT    NOT NULL,
        updated_at    TEXT    NOT NULL
      );

      -- 系统配置。决策 9 要求"联网搜索 provider 由管理端可配置"，就落在这张表。
      -- 用 key-value 而不是固定列：配置项会持续增加，每加一项就改表结构不可接受。
      CREATE TABLE system_config (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT REFERENCES users(id)
      );
    `,
  },
  {
    version: 2,
    name: 'documents-and-search-index',
    sql: `
      -- 文档主表。material 对应设计文档里的 M-PAPER / M-KNOW / M-EXP / M-SOP ...
      CREATE TABLE documents (
        id           TEXT PRIMARY KEY,
        material     TEXT NOT NULL,
        title        TEXT NOT NULL,
        source_path  TEXT,
        content_hash TEXT NOT NULL,
        group_id     TEXT,
        uploaded_by  TEXT REFERENCES users(id),
        status       TEXT NOT NULL DEFAULT 'ready',
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_documents_material ON documents(material);
      CREATE INDEX idx_documents_content_hash ON documents(content_hash);

      -- 切块。text 用于展示，text_seg 是逐字切分后的索引形态。
      -- 为什么存两份：FTS5 的 external content 模式要求分词器作用于表的原始列，
      -- 而我们必须在写入前就完成切分，所以把切分结果单独落一列。
      CREATE TABLE doc_chunks (
        id          TEXT PRIMARY KEY,
        doc_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal     INTEGER NOT NULL,
        text        TEXT NOT NULL,
        text_seg    TEXT NOT NULL,
        page        INTEGER,
        token_count INTEGER,
        UNIQUE (doc_id, ordinal)
      );
      CREATE INDEX idx_doc_chunks_doc ON doc_chunks(doc_id);

      -- 检索索引。tokenize 必须是 unicode61（默认）：
      --   trigram 对长度 <3 的查询返回 0 命中，中文两字词全废；
      --   逐字切分已在 shared/segmentForIndex 完成，这里只需按空格切 token。
      CREATE VIRTUAL TABLE doc_chunks_fts USING fts5(
        text_seg,
        content='doc_chunks',
        content_rowid='rowid',
        tokenize='unicode61'
      );

      -- external content 模式不会自动同步，必须自己挂触发器，
      -- 否则 doc_chunks 有数据而索引为空 —— 表现为"明明传了文档却搜不到"。
      CREATE TRIGGER doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
        INSERT INTO doc_chunks_fts(rowid, text_seg) VALUES (new.rowid, new.text_seg);
      END;

      CREATE TRIGGER doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
        INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, text_seg)
        VALUES ('delete', old.rowid, old.text_seg);
      END;

      CREATE TRIGGER doc_chunks_au AFTER UPDATE ON doc_chunks BEGIN
        INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, text_seg)
        VALUES ('delete', old.rowid, old.text_seg);
        INSERT INTO doc_chunks_fts(rowid, text_seg) VALUES (new.rowid, new.text_seg);
      END;
    `,
  },
  {
    version: 3,
    name: 'documents-file-name-and-size',
    sql: `
      -- 原始文件名与字节数。阶段 1 上传时才第一次需要，所以在这里追加。
      --
      -- 为什么 file_name 不能复用 title：
      --   title 是"这篇论文叫什么"（单元 2 会尝试从 PDF 元数据里提取更准确的名字），
      --   file_name 是"上传时它叫什么"（常见是 paper_v3_final(2).pdf）。
      --   两者经常不同。丢掉 file_name，界面上就只能显示哈希文件名。
      --
      -- 两列都可空：阶段 0 建的表里没有数据，且历史行补齐没有意义。
      ALTER TABLE documents ADD COLUMN file_name TEXT;
      ALTER TABLE documents ADD COLUMN byte_size INTEGER;
    `,
  },
  {
    version: 4,
    name: 'chunk-section-path-and-ingest-note',
    sql: `
      -- 块所属的章节路径，JSON 数组，如 ["3 Methods","3.1 Encoder-Decoder"]。
      --
      -- 为什么用 JSON 而不是 "3 Methods > 3.1 Encoder" 这种拼好的字符串：
      -- 章节标题本身可能含分隔符，拼字符串之后再拆就还原不回来了。
      -- 存数组，展示格式由 shared/formatSectionPath 决定，前端和 Agent 引用共用一处。
      --
      -- 可空：阶段 0/1 早期入库的块没有这个信息，且 Word/纯文本本就没有章节结构。
      ALTER TABLE doc_chunks ADD COLUMN section_path TEXT;

      -- 解析/索引的说明或失败原因。见 packages/shared 里 DocumentSummary.ingestNote 的注释：
      -- 上传与检索之间可能隔很久，那时响应早没了，"这份文档为什么搜不到"仍要答得上来。
      ALTER TABLE documents ADD COLUMN ingest_note TEXT;
    `,
  },
  {
    version: 5,
    name: 'chunk-embeddings',
    sql: `
      -- 语义检索用的向量。单独一张表，不给 doc_chunks 加列，三个理由：
      --   1. doc_chunks 是 FTS5 的 external content 表，列表页、摘要、计数都要读它。
      --      每个块 4 KB 的 BLOB 混在同一行里，会让所有跟向量无关的查询都拖着它走。
      --   2. 一个块可能同时存在不同模型的向量（换模型时新旧并存、逐步切换），
      --      列结构会把"一个块只能有一份向量"写死。
      --   3. 删块时向量必须跟着删，独立表用外键声明这件事比散在代码里可靠。
      --
      -- vec 是 float32 小端紧密排列的字节串，长度必须是 dim * 4。
      -- 存 BLOB 而不是 JSON 文本：1024 维的 JSON 约 20 KB，是二进制形态的 5 倍，
      -- 几千个块就是几十 MB 的纯浪费，且每次查询都要 parse 一遍。
      CREATE TABLE chunk_embeddings (
        chunk_id   TEXT PRIMARY KEY REFERENCES doc_chunks(id) ON DELETE CASCADE,
        -- 模型标识（如 bge-m3-q8）。没有它就无法判断一条向量是谁算的 ——
        -- 不同模型的向量空间不可比，混用会让相似度彻底失去意义，
        -- 而且是静默的：不报错、不崩溃，只是结果变差。换模型时必须靠它筛出旧向量。
        model      TEXT NOT NULL,
        -- 维度。读 BLOB 时要按 float32 逐 4 字节解析，长度算错会得到一堆乱码数字，
        -- 且不会报错，只会让排序完全随机。存下来用于自检。
        dim        INTEGER NOT NULL,
        vec        BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_chunk_embeddings_model ON chunk_embeddings(model);
    `,
  },
  {
    version: 6,
    name: 'ask-records',
    sql: `
      -- 一次问答一行。回答正文与引用快照【刻意不存】——
      -- 正文和摘录都是从知识库里摘出来的原文，存下来等于把未发表内容
      -- 复制到一个新的长期留存载体里；而这张表要解决的问题只有一个：
      -- "提问时告知过、用户勾过确认"这件事必须可追溯（约束 4 + 设计文档 04 §7.3）。
      -- 证明"他勾过"不需要正文，所以不存。
      --
      -- 粒度说明：这是【run 级】（一次问答一行），与阶段 3 的 usage_events
      -- （模型调用级，一次问答会有好几行）是 1:N，靠 run_id 关联。两张表不要合并。
      CREATE TABLE ask_records (
        run_id            TEXT    PRIMARY KEY,
        -- 问题原文，不脱敏。脱敏会连关键信息一起抹掉，反而失去追溯价值；
        -- 改为在提问入口如实告知"提问会被记录"（见 AskRequest.consentConfirmed 注释）。
        question          TEXT    NOT NULL,
        asked_at          TEXT    NOT NULL,
        -- 0/1。SQLite 没有 boolean，存整数；读取时转 true/false。
        consent_confirmed INTEGER NOT NULL,
        -- ok | timeout | model_error | exception。见 shared/answer.ts 的 AskOutcome
        -- 为什么不是"成功/失败"两档：这四种在排查时指向完全不同的原因。
        outcome           TEXT    NOT NULL,
        -- 只记条数、不记内容：够回答"这次回答有没有出处"，又不用留存引用了什么。
        citation_count    INTEGER NOT NULL,
        gap_count         INTEGER NOT NULL,
        rounds            INTEGER NOT NULL,
        duration_ms       INTEGER NOT NULL,
        input_tokens      INTEGER NOT NULL,
        output_tokens     INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        cost_usd          REAL    NOT NULL,
        -- JSON 数组的字符串形式。存 JSON 而不是逗号拼接：警告文案里本身可能含逗号。
        warnings          TEXT    NOT NULL
      );

      -- 追溯与"看最近问了什么"都按时间倒序取，这是唯一需要的读取方式。
      CREATE INDEX idx_ask_records_asked_at ON ask_records(asked_at DESC);
    `,
  },
  {
    version: 7,
    name: 'documents-index-version',
    sql: `
      -- 这份文档当前的块，是由哪一版解析/切块流水线切出来的。
      -- 见 packages/shared/src/documents.ts 的 INDEX_VERSION。
      --
      -- 为什么要落库：切块策略或页眉页脚规则一改，已入库的块就是按老规则切的。
      -- 它们**还搜得到**，只是切法过时 —— 这类"看起来正常、实际已陈旧"的状态
      -- 如果只能靠人记，就一定会被忘掉。存下来，界面才问得出口"哪些需要重建"。
      --
      -- ⚠️ 这里硬编码的 1 不要跟着 INDEX_VERSION 一起改。
      -- 迁移只执行一次，它记录的是"此刻表里所有行都由当时那版管线建的"这个历史事实
      -- （阶段 1 到现在切块策略没变过）。已发布的迁移一个字都不能改，
      -- 这是 migrations.ts 开头第 1 条规则。
      ALTER TABLE documents ADD COLUMN index_version INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 8,
    name: 'usage-events',
    sql: `
      -- 每次模型调用一行（C-USAGE，需求 7）。与 ask_records（一次问答一行）是 1:N，
      -- 靠 run_id 关联。两张表不合并：这张回答"钱花在哪一次调用上"，
      -- 那张回答"这次问答是谁在什么时候问的、他勾过确认没有"。
      --
      -- 【为什么这张表里没有 question，也没有文档标题】
      --   01 号文档 §6.2 要求：论文题目、未发表内容、投稿期刊**不进入用量流水**。
      --   所以这里只有 run_id、模型名和数字。要追"是哪次问的"就靠 run_id 连回
      --   ask_records，内容留在那一张表里；用量流水本身保持"只有元数据"。
      CREATE TABLE usage_events (
        id             INTEGER PRIMARY KEY,
        -- 上游事件号，唯一索引 = 强重放保护。
        -- 取值形如 "<run_id>:<本轮序号>"，是【确定性】的而不是随机 UUID ——
        -- 随机值在同一次调用被重记两遍时两次互不相同，唯一索引也就拦不住了。
        event_id       TEXT    NOT NULL,
        -- 阶段 1–3 没有登录，一律 NULL（与 documents.uploaded_by 同一判断）。
        -- 阶段 4 加登录后由当前用户回填；**不要在阶段 4 之前塞占位用户**。
        user_id        TEXT    REFERENCES users(id),
        -- 可空：模型调用不一定属于某次问答（如 npm run smoke）。
        run_id         TEXT,
        model          TEXT    NOT NULL,
        -- generate | retrieve | verify | reflow。现在只有 generate ——
        -- 检索走本地 BGE-M3（进程内 ONNX 推理），不经模型 API，没有 token 可记。
        purpose        TEXT    NOT NULL,
        -- 以下六项【可空】，不是笔误。规则是"取不到就存 NULL，不估算冒充实际值"
        -- （01 号 §5 C-USAGE 的失败反馈）。DeepSeek 目前每项都给，所以实际都是数字；
        -- 但若某家 provider 不报 cacheRead，记 0 会和"确实没命中缓存"塌成同一个值，
        -- 之后所有成本分析都建在这个假数上，而且看不出来。
        input_tokens   INTEGER,
        output_tokens  INTEGER,
        cache_read     INTEGER,
        cache_creation INTEGER,
        cost_usd       REAL,
        duration_ms    INTEGER,
        created_at     TEXT    NOT NULL
      );

      CREATE UNIQUE INDEX idx_usage_events_event ON usage_events(event_id);
      -- 两种读法各配一个索引：按时间倒序扫最近（报表），按 run 收口对账（对账）。
      CREATE INDEX idx_usage_events_created ON usage_events(created_at DESC);
      CREATE INDEX idx_usage_events_run ON usage_events(run_id);
    `,
  },
  {
    version: 9,
    name: 'submission-ledger',
    sql: `
      -- 投稿台账（需求 4）。
      --
      -- 【为什么四张表放同一条迁移】submissions 需要 journals 的外键，
      -- journal_rankings 挂 journals，submission_history 挂 submissions ——
      -- 它们是一个整体，拆成多条只会让外键的先后顺序更难保证，
      -- 而迁移是「要么全生效、要么全回滚」的，一条里放齐反而更安全。
      --
      -- 【为什么独独这张表不能只有一条记录】投稿台账要回答的是
      -- 「我投的 X 现在什么状态」。上传的旧文档答不了这个问题 ——
      -- 它记的是当时的状态。这正是 01 号 §2 把 M-SUBMIT 归为
      -- 「实时结构化查询」、不能由历史文档代替的原因。

      -- 期刊。分区与领域都挂在它上面。
      CREATE TABLE journals (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        -- ISSN 现在靠手填，允许为空；将来联网补全后回填。
        issn       TEXT,
        -- 领域（如 "计算机视觉"）。需求 4 的「领域」就取这里。
        field      TEXT,
        created_at TEXT NOT NULL
      );

      -- 去重键。COLLATE NOCASE 让 "Nature" 与 "nature" 视为同一本刊；
      -- 中文没有大小写，不受影响。
      -- 【为什么必须去重】台账录入时按刊名 find-or-create。没有这条约束，
      -- 同一本刊会因为多敲一个空格被录成两行，之后分区数据也跟着分成两份 ——
      -- 表现为「明明录过分区了，这一条却显示未收录」，且不会有任何报错。
      CREATE UNIQUE INDEX idx_journals_name ON journals(name COLLATE NOCASE);

      -- 分区。**按年份版本化，不覆盖历史**（04 号 §4 数据层硬约束 1）。
      -- 中科院分区每年 12 月更新、JCR 每年 6 月更新，所以"几区"是个带年份的事实。
      CREATE TABLE journal_rankings (
        id          TEXT    PRIMARY KEY,
        journal_id  TEXT    NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
        -- 必须带年份。不带年份的"几区"过一年就是错的，而且错得看不出来 ——
        -- 用户没法分辨"这是一年前的答案"还是"这是今年的答案"。
        year        INTEGER NOT NULL,
        -- 分区体系（如 "中科院" / "JCR"）。同一本刊同一年可以同时有多个体系的分区，
        -- 所以去重键必须带上它 —— 只有 (journal_id, year) 会让第二个体系覆盖掉第一个。
        system      TEXT    NOT NULL,
        rank        TEXT    NOT NULL,
        -- web_search | manual | official（04 号 §4 定的词表）。
        source      TEXT    NOT NULL,
        -- 0/1。**联网结果默认不可信**，人工核对后才置 1（决策 2、决策 10）。
        -- 回答里引用未核验的分区时必须标注「未经权威数据源核对」。
        verified    INTEGER NOT NULL DEFAULT 0,
        verified_by TEXT    REFERENCES users(id),
        verified_at TEXT,
        -- 溯源：这条分区从哪来、什么时候抓的。没有这两列，
        -- 一条错的分区就无从复核，只能整个删掉重来。
        source_url  TEXT,
        fetched_at  TEXT    NOT NULL,
        created_at  TEXT    NOT NULL
      );

      -- 决策 10 四条硬约束的第三条落地成结构：唯一键防重复回填。
      -- 同一本刊、同一年、同一体系只该有一条 —— 联网重抓时靠它做 upsert，
      -- 而不是每次抓完插一条新的。
      CREATE UNIQUE INDEX idx_journal_rankings_key
        ON journal_rankings(journal_id, year, system);

      -- 投稿记录。一行 = 一篇稿子。
      CREATE TABLE submissions (
        id           TEXT PRIMARY KEY,
        -- 阶段 1–3 没有登录：一律 NULL。
        -- 与 documents.uploaded_by、usage_events.user_id 同一个判断 ——
        -- 宁可留空，也不塞一个将来要清理的占位用户。
        user_id      TEXT REFERENCES users(id),
        title        TEXT NOT NULL,
        -- 可空：先记下"投了这篇"，刊名回头再补。
        journal_id   TEXT REFERENCES journals(id),
        -- 【特意不加 CHECK 约束】合法性由 shared 的受控词表 + 服务端校验保证。
        -- 理由与 ask_records.outcome 完全相同：稿件状态的档位是业务规则，
        -- 很可能随实验室习惯变（加一档"大修"、去掉"待上线"），
        -- 而迁移一旦发布就一个字都不能改 —— 加了 CHECK，
        -- 一次词表调整就变成一次迁移 + 一次全表校验。这里同样是给后续留活口。
        status       TEXT NOT NULL,
        -- 可空：还没投出去的稿子没有投稿时间。
        submitted_at TEXT,
        -- 状态或备注一变就更新。台账列表按它倒序 —— 最近动过的排在最上面。
        updated_at   TEXT NOT NULL,
        notes        TEXT,
        created_at   TEXT NOT NULL
      );

      -- 列表固定按"最近更新"倒序取，这是唯一需要的读取方式。
      CREATE INDEX idx_submissions_updated ON submissions(updated_at DESC);

      -- 状态时间线。04 号 §3.3 的「我的投稿」页要求显示状态时间线。
      --
      -- 【为什么状态变更要单独留痕，而不是只改 submissions.status】
      --   只存当前状态的话，"这篇在外审停了三个月"这件事就没了 ——
      --   而那恰恰是需求 8 巡检要判断的东西，也是用户最想回看的。
      --   一张能被静默改写的历史等于没有历史。
      CREATE TABLE submission_history (
        id            TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
        -- 可空：建档那一条没有"从哪个状态来"。
        from_status   TEXT,
        -- 与 submissions.status 同一口径，同样不加 CHECK。
        to_status     TEXT NOT NULL,
        -- 阶段 1–3 无登录：一律 NULL。
        changed_by    TEXT REFERENCES users(id),
        changed_at    TEXT NOT NULL,
        note          TEXT
      );

      CREATE INDEX idx_submission_history_sub
        ON submission_history(submission_id, changed_at);
    `,
  },
  {
    version: 10,
    name: 'code-assets',
    sql: `
      -- 代码与数据集（需求 5）。一行 = 一个数据集的**指路牌**。
      --
      -- 【它与 documents 的根本差别】文档上传后内容进了库，原件在不在都还能检索；
      -- 而代码与数据集永远留在文件系统上，这里只有路径。所以这张表要能表达
      -- "这条指路牌此刻还指得对不对" —— 那是需求 5 的「路径有效性巡检」，
      -- 也是 01 号 §2 把这四类事实归为"不能由历史文档代替"的原因之一。
      CREATE TABLE code_assets (
        id          TEXT PRIMARY KEY,
        -- 所属项目/课题。可空。列表按它分组显示（04 号 §1 说的
        -- "类别标签"替代全量知识地图），所以不强制填。
        project     TEXT,
        name        TEXT NOT NULL,
        -- 路径或地址，原样保存。**登记时不校验是否在允许根目录内**：
        -- 在开发机上根本登记不了服务器上的数据集，而"记录在哪"和
        -- "本机能不能去看"是两件事。真正的越界拒绝落在读取侧（阶段 4 的 C-FS）。
        location    TEXT NOT NULL,
        -- 这份东西在哪台机器上。NULL = 服务所在的这台机器。
        -- 这一列决定本机该不该去探测：声明了主机的记录一律不探，
        -- 否则在 Windows 开发机上会把服务器上的数据集全报成"未找到"。
        host        TEXT,
        access_note TEXT,
        notes       TEXT,
        -- 【四态，不是布尔】04 号 §4 给的是 exists_flag。改成结果枚举的理由见
        -- shared/code-assets.ts 顶部：布尔会把"确实没有"和"本机看不到"塌成同一个值，
        -- 而这两者的处置完全相反（一个要去找回来，一个不用管）。
        -- 初始值 unchecked：还没核对过 ≠ 没找到。
        -- 与 submissions.status 同一口径，**不加 CHECK** —— 词表可能变，
        -- 而迁移一旦发布一个字都不能改。
        last_check_result TEXT NOT NULL DEFAULT 'unchecked',
        last_checked_at   TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      -- 列表固定按项目分组读，这是唯一需要的读取方式。
      CREATE INDEX idx_code_assets_project ON code_assets(project);
    `,
  },
  {
    version: 11,
    name: 'upload-sessions',
    sql: `
      -- 分片上传的会话（大文件进数据集目录）。
      --
      -- 【为什么表里没有"已收到哪些分片"这一列】
      --   分片就躺在磁盘上（DATA_ROOT/.incoming/<id>/<n>.part），磁盘本身
      --   已经完整回答了这个问题。再存一列就是同一件事有两处记录，而它们
      --   必然会分叉：磁盘上有片而库里漏记 → 续传时漏拼几片；库里有记而
      --   文件被清 → complete 拼不出来。两边的症状都是"文件坏了、大小却正常"。
      --   所以**磁盘是唯一事实来源**，这张表只存磁盘答不出来的东西：
      --   目标在哪、本来该多大、分几片、状态如何。
      CREATE TABLE upload_sessions (
        -- sha256(目标目录 + 文件名 + 总字节 + 最后修改时间)，由服务端算。
        -- 用派生键而不是随机 UUID：同一个文件重传拿到同一个 id，
        -- 于是"续传"和"新建"不需要两个接口，也不会把两份文件拼成一份。
        id            TEXT PRIMARY KEY,
        -- 相对 DATA_ROOT 的 POSIX 相对路径（如 medical/amos22）。
        -- 存相对路径而不是绝对：DATA_ROOT 换盘/换机器时全部记录仍然有效，
        -- 而同项目 documents.source_path 存相对仓库根是同一个理由。
        target_dir    TEXT NOT NULL,
        file_name     TEXT NOT NULL,
        total_bytes   INTEGER NOT NULL,
        -- 分片大小由服务端决定并下发，两边各算一套的话最后一片的边界
        -- 会对不上，而症状只是"永远传不完"。
        chunk_size    INTEGER NOT NULL,
        chunk_count   INTEGER NOT NULL,
        -- pending / completed / aborted。与 submissions.status 同一口径，
        -- **不加 CHECK**：词表可能变，而迁移一旦发布一个字都不能改。
        status        TEXT NOT NULL DEFAULT 'pending',
        -- completed 后才有：最终文件相对 DATA_ROOT 的路径。
        stored_path   TEXT,
        -- completed 后才有：整份文件的 sha256，供调用方自行核对。
        sha256        TEXT,
        created_at    TEXT NOT NULL,
        -- 兼作"这个会话还活着吗"的判据：清理超时未完成的会话靠它。
        updated_at    TEXT NOT NULL
      );

      -- 清理只按"多久没动过"找超时会话，这是唯一需要的扫描方式。
      CREATE INDEX idx_upload_sessions_updated ON upload_sessions(updated_at);
    `,
  },
  {
    version: 12,
    name: 'organize-plans',
    sql: `
      -- 数据集整理（阶段 3 增补 B）：对话 → Agent 拟计划 → 人确认 → 才执行。
      --
      -- 【为什么计划要先落库再执行】这是本模块唯一会**改真实数据**的动作，
      --   而"可追溯：谁做了什么"这条要求不能只靠事后一份"执行日志"来满足 ——
      --   中途崩了、进程被杀、机器断电，日志就没写下来。先把"本来打算做什么"
      --   落成一行（status='pending'）再动手，事后总能回答"那次是打算把哪些
      --   文件移到哪、执行到第几条断的"。这与阶段 1「向量化放在事务之外」的
      --   判断相反，因为这里的动作**不可逆**：副本算错了可以重算，文件移错了
      --   不会自己回来。
      --
      -- 【键是 id 而不是 asset_id】一个数据集可以整理很多次（用户改了规则、
      --   隔天又整理一遍）。用 asset_id 当主键的话第二次整理会覆盖第一次的痕迹，
      --   而"上个月那次把 val 混进了 train"这种问题恰恰要能翻出来。
      CREATE TABLE organize_plans (
        id            TEXT PRIMARY KEY,
        -- 指向 code_assets.id（数据集登记行）。
        asset_id      TEXT NOT NULL,
        -- 数据集根，**绝对路径**，执行时冻结下来的那份。
        -- 不存相对路径：整理是"此刻对这台机器上这个目录"做的事，事后复盘要问的
        -- 是"它当时到底动的是哪个目录"，而 DATA_ROOT 换过之后相对路径会指向别处。
        dataset_dir   TEXT NOT NULL,
        -- 白话计划说明：Agent 给用户看的那段话，原样存下来。
        summary       TEXT NOT NULL,
        -- OrganizeRule[] 的 JSON。规则是一份 glob→目录的映射清单。
        -- 存 JSON 不拆表：规则永远是**整体**读写的（读出来渲染、写下去执行），
        -- 没有"按某条规则查"的场景，拆表只会多一层 join。
        rules_json    TEXT NOT NULL,
        -- pending / executed / failed。与 submissions.status 同一口径，
        -- **不加 CHECK**：词表可能变，而迁移一旦发布一个字都不能改。
        status        TEXT NOT NULL,
        -- 用户确认时预览出来的条数（= 执行请求里的 expectedMoves）。
        -- 执行时拿它和实际匹配数对账，不符就拒 —— 否则"用户确认过的预览"
        -- 与"真正被执行的东西"可能不是同一件事，确认就成了走过场。
        planned_moves INTEGER NOT NULL,
        moved         INTEGER NOT NULL DEFAULT 0,
        failed_count  INTEGER NOT NULL DEFAULT 0,
        -- 失败原因 / 校验拒绝的说明。成功时为空。
        note          TEXT,
        -- 阶段 1–3 没有登录。与 documents.uploaded_by 同一个判断：宁可留空，
        -- 也不塞一个将来要清理的占位用户。阶段 4 与登录一起回填。
        created_by    TEXT,
        created_at    TEXT NOT NULL,
        executed_at   TEXT
      );

      -- 只按数据集查历史，且最近的排前面：这是这一页唯一的读法。
      CREATE INDEX idx_organize_plans_asset ON organize_plans(asset_id, created_at);

      -- 每个动作（建目录 / 移动）单独一行。
      --
      -- 【为什么不把动作清单也塞进 plan 行的一个 JSON 列】执行会**部分失败**：
      --   120 条里第 87 条重名改不了。要如实汇报"哪些成了、哪条没成、为什么"，
      --   就得能按条查、按条算数（moved/failed_count 是从这里数出来的）。
      --   塞进一个 JSON 列的话，每次读都要在应用层解一遍、数一遍，
      --   而"数错了"与"执行错了"在界面上长得一样。
      CREATE TABLE organize_actions (
        id         TEXT PRIMARY KEY,
        plan_id    TEXT NOT NULL,
        -- 执行序。复盘时要能看出"它在第几步被处理的"，尤其是失败那条。
        ord        INTEGER NOT NULL,
        -- mkdir | move。同 status，不加 CHECK。
        action     TEXT NOT NULL,
        -- 相对数据集根的 POSIX 路径；mkdir 没有来源，为 NULL。
        from_path  TEXT,
        -- 相对数据集根的 POSIX 路径。移动的目标文件，或新建的目录。
        to_path    TEXT NOT NULL,
        -- done | skipped | failed。
        status     TEXT NOT NULL,
        -- 失败/跳过的原因（重名改名了、目标已存在、rename 报错…）。
        reason     TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_organize_actions_plan ON organize_actions(plan_id, ord);
    `,
  },
  {
    version: 13,
    name: 'journal-ranking-category',
    sql: `
      -- 期刊分区库（阶段 3 增补 C）。
      --
      -- 【为什么要动唯一键】v9 的键是 (journal_id, year, system)，一本刊
      --   同一年同一体系只能有一条。但分区**不止一个维度**：中科院分区表
      --   既有"大类分区"（计算机科学 3 区）又有"小类分区"（遥感 4 区），
      --   两者可以不同 —— 比如 European Journal of Remote Sensing 大类 3 区、
      --   遥感小类 4 区。键里不带 category，这两条就存不下：第二条会被
      --   当成重复而 upsert 覆盖掉第一条，表现为"明明导入了遥感小类，
      --   页面上却只剩大类"。所以键扩成 (journal_id, year, system, category)。
      --
      -- 【为什么要加 top 和 note】中科院分区表里 "Top 期刊" 是编辑部的
      --   官方标注，不是我们算出来的，必须原样存下来；"排名 4/758" 这类
      --   分母信息则是判断"这个 1 区含金量多少"的依据。都塞进 rank 字符串
      --   会让人分不清哪部分是档位、哪部分是补充说明。
      --
      -- 【为什么是重建而不是 ALTER】SQLite 不能修改已有索引的列集合，
      --   也不能给已有列加约束。走标准重建流程（建新表 → 拷数据 → 删旧 →
      --   改名），不假设表是空的 —— 即便当前部署里它是 0 行，换个部署
      --   可能不是。拷贝时新列取默认值（category=''，top=0，note=NULL），
      --   这与 v9 时期写入的行本来就没有这两类信息的语义是一致的。
      CREATE TABLE journal_rankings_v13 (
        id          TEXT    PRIMARY KEY,
        journal_id  TEXT    NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
        year        INTEGER NOT NULL,
        system      TEXT    NOT NULL,
        rank        TEXT    NOT NULL,
        -- 分区维度：中科院是学科名（大类或小类），JCR 是 Category。
        -- 旧数据没有这个概念，回填成空串 —— 空串在界面上不显示，
        -- 比塞一个假的学科名更诚实。
        category    TEXT    NOT NULL DEFAULT '',
        -- 0/1。中科院分区表的 Top 期刊标注；JCR 行恒为 0。
        top         INTEGER NOT NULL DEFAULT 0,
        -- 档位之外的补充：排名（4/758）、影响因子（IF 20.4）。可空。
        note        TEXT,
        source      TEXT    NOT NULL,
        verified    INTEGER NOT NULL DEFAULT 0,
        verified_by TEXT    REFERENCES users(id),
        verified_at TEXT,
        source_url  TEXT,
        fetched_at  TEXT    NOT NULL,
        created_at  TEXT    NOT NULL
      );

      INSERT INTO journal_rankings_v13
        (id, journal_id, year, system, rank, source, verified, verified_by,
         verified_at, source_url, fetched_at, created_at)
      SELECT
        id, journal_id, year, system, rank, source, verified, verified_by,
        verified_at, source_url, fetched_at, created_at
      FROM journal_rankings;

      DROP TABLE journal_rankings;
      ALTER TABLE journal_rankings_v13 RENAME TO journal_rankings;

      -- 同键唯一：一个刊 × 一年 × 一体系 × 一维度，只该有一条。
      CREATE UNIQUE INDEX idx_journal_rankings_key
        ON journal_rankings(journal_id, year, system, category);

      -- 分区库页要按刊名搜到刊之后，一次拉出它**全部年份全部维度**的分区，
      -- 按年份倒序显示。这条索引就是为那个读法建的。
      CREATE INDEX idx_journal_rankings_journal
        ON journal_rankings(journal_id, year DESC);
    `,
  },
  {
    version: 14,
    name: 'auth-sessions',
    sql: `
      -- 登录会话（阶段 4 单元 4A）。
      --
      -- 【为什么主键是 token 的哈希，而不是 token 本身】
      --   会话 cookie 就是一个 bearer 凭据：谁拿到它谁就是那个用户。
      --   存明文等于"库文件被拷走 = 所有人被登录"，而库文件恰恰是最容易被
      --   顺手复制走的东西（一条 scp、一次备份）。存 sha256 之后，拿到库
      --   只能看到一串哈希，反推不出 token。这与 users.password_hash 是
      --   同一个判断。
      --
      -- 【为什么 token 只用 sha256、不像口令那样用 scrypt】
      --   scrypt 是给**低熵**输入（人选的口令）用的，靠慢来抵抗穷举。
      --   token 是 randomBytes(32) 的 256 bit 随机值，穷举空间大到慢哈希
      --   没有意义，反而让每个请求都慢 50ms。低熵要慢，高熵不需要。
      --
      -- 【为什么不用签名 cookie / JWT】
      --   本项目要的是**可吊销**：登出、改密、把账号 status 改成 disabled
      --   都必须立刻失效。JWT 无状态，吊销只能另建 denylist，等于把这张表
      --   又加回来；滑动过期还得不断重签。单机几十人，一次索引查找的成本
      --   完全可以忽略。
      CREATE TABLE auth_sessions (
        -- sha256(rawToken) 的十六进制。唯一索引由主键承担。
        token_hash   TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   TEXT NOT NULL,
        -- 每次带这个 token 的请求都会推进它（但不一定写库，见 session.ts），
        -- 用于判断"这个会话还活着吗"。
        last_seen_at TEXT NOT NULL,
        -- 绝对上限，与闲置时长无关：一个会话最长活这么久，之后必须重新登录。
        -- 只有闲置上限的话，天天来的人永远不会被要求重登。
        expires_at   TEXT NOT NULL,
        -- 审计用。可空：脚本/测试造的会话没有这两个值。
        ip           TEXT,
        user_agent   TEXT
      );

      -- 改密、禁用、删除用户时要"踢掉这个人的全部会话"，按 user_id 找。
      CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);

      -- 启动时清理过期会话：只按过期时间扫，这是唯一的批量删除方式。
      CREATE INDEX idx_auth_sessions_expires ON auth_sessions(expires_at);
    `,
  },
  {
    version: 15,
    name: 'ownership-columns',
    sql: `
      -- 阶段 4 单元 4A：把"这条记录是谁的"补齐。
      --
      -- 【为什么现在才加】阶段 1–4A 之前没有登录（users 表是空的），
      --   凡是跟"人"有关的列只能留 NULL。现在有了会话，写入侧才能回填。
      --
      -- 【为什么全部可空】历史行确实没有归属 —— 那时候没有用户可记。
      --   可空 + "NULL 视为公共历史数据" 是唯一诚实的表达方式，
      --   比塞一个占位用户（"系统"）更好：占位用户会让"谁做过这件事"
      --   永远查不出来，而 NULL 至少说的是实话。

      -- 设计文档 04 §7.3 要求的云端告知确认留痕。
      -- 上传时 consentConfirmed 已经在接口层校验（没有勾就不落库），
      -- 这两列记的是"谁在什么时候勾的"，作为事后追溯依据。
      -- 同样可空：这份文档可能是在还没有登录的年代传的。
      ALTER TABLE documents ADD COLUMN consent_confirmed_by TEXT REFERENCES users(id);
      ALTER TABLE documents ADD COLUMN consent_confirmed_at TEXT;

      -- 问答记录（v6）建表时没有归属列。提问原文不脱敏（用户明确选择），
      -- 所以"谁能看谁的提问"必须能判 —— 没有这一列，行级过滤无从下手。
      ALTER TABLE ask_records ADD COLUMN user_id TEXT REFERENCES users(id);

      -- 数据集（v10）同样没有归属列。阶段 3 的欠账清单里写着
      -- "只能修改或删除自己登记的数据集"，判据就落在这张表上。
      ALTER TABLE code_assets ADD COLUMN created_by TEXT REFERENCES users(id);

      -- 问答记录按"某人的提问历史"读，一律按时间倒序。
      CREATE INDEX idx_ask_records_user ON ask_records(user_id, asked_at DESC);

      -- 数据集列表按归属筛。
      CREATE INDEX idx_code_assets_created_by ON code_assets(created_by);

      -- 【有意不动 organize_plans.created_by】它在 v12 就存在，但没带外键。
      --   SQLite 无法用 ALTER 给已有列补约束，只能重建整张表；而重建换来的
      --   仅是一条引用完整性（写入侧由代码保证，且这张表当前只有 1 行 NULL）。
      --   为一条约束重建一张有子表的表，收益不抵风险。这一处不一致是既有的，
      --   如实记账，不在本期夹带返工。
    `,
  },
  {
    version: 16,
    name: 'upload-session-owner',
    sql: `
      -- 阶段 4 欠账：分片上传的会话此前是**全局的** —— 谁都能碰。
      --
      -- 【为什么这一条是真的漏洞，而不是"少了一层便利"】会话 id 由**文件自身的
      --   特征**派生（目标目录 + 文件名 + 总字节 + 最后修改时间，见 shared/uploads.ts），
      --   所以它不是一个秘密：知道那个文件的人自己就能把这个 id 算出来。
      --   于是"接着传别人的半截上传"、"把别人传了一半的文件拼完落位"、
      --   "放弃掉别人正在传的任务"都不需要任何身份。补上归属列之后，
      --   路由按 owner-or-admin 判，列表按可见范围筛。
      --
      -- 【为什么可空】阶段 3 建这张表时还没有登录（users 表是空的），
      --   那时产生的会话没有归属可记。与 v15 同一条口径：
      --   **NULL = 公共历史数据**，不做"洗成某个人的"这种编造。
      ALTER TABLE upload_sessions ADD COLUMN created_by TEXT REFERENCES users(id);

      -- 列表按归属筛（与 idx_code_assets_created_by 同一个理由）。
      CREATE INDEX idx_upload_sessions_created_by ON upload_sessions(created_by);
    `,
  },
  {
    version: 17,
    name: 'knowledge-entries',
    sql: `
      -- 阶段 5：知识沉淀（需求 9）。
      --
      -- 【为什么单开一张表，而不是把草案塞进 documents】
      --   documents 是"**进了索引的东西**"的名册 —— 凡是进了 documents 的都会被
      --   检索到（search.ts 只按 d.material 过滤，**从不看 documents.status**）。
      --   而安全卡点 GC-12（03 号 §安全用例）要求草案"未确认就检索不到"，
      --   所以草案必须待在索引之外。确认之后才由本表指向一份 documents
      --   （见 document_id 列），检索链路因此一个字都不用改。
      --
      -- 【关于 status 为什么不加 CHECK 约束】沿用 submissions.status /
      --   documents.material / organize_plans.status 的既有口径：词表还会长
      --   （阶段 6 可能加 pending_review 之类），而迁移一旦发布一个字都不能改。
      --   校验放在 shared 的受控词表 + 服务端。
      CREATE TABLE knowledge_entries (
        id            TEXT PRIMARY KEY,
        -- 受控词表，见 shared 的 KNOWLEDGE_KINDS
        -- （04 号 §数据模型：fact | decision | lesson | open_loop）
        kind          TEXT NOT NULL,
        -- proposed | active | conflicted | superseded | deleted
        status        TEXT NOT NULL,
        -- 结构化后的正文。也是"确认"时那份 markdown 的正文（标题另由
        -- shared 的 knowledgeTitle() 现算，不落列 —— 免得正文改了标题却不跟着变）。
        content       TEXT NOT NULL,

        -- 【来源三件套的语义，v1 全都不用，但先占位】
        --   source_type：这条知识从哪来。v1 只有"对话/白话输入"一条来源，
        --     恒为 'conversation'；'upload' / 'manual' 先写进词表占位。
        --   source_id：**会话之外的外部业务对象 id**（某条投稿、某个数据集）。
        --     刻意**不拿它存 documents.id** —— 来源字段是要长期诚实的东西，
        --     把"这条知识后来进了索引"写进 source_id 会让"来源"在确认前后
        --     改变含义。所以另开 document_id 列。
        --   session_id：来源会话。留给阶段 6（若把沉淀挂到问答页的"沉淀这段对话"）。
        source_type   TEXT NOT NULL,
        source_id     TEXT,
        session_id    TEXT,

        -- 这条知识**被观察到**的时间（服务端在生成草案那一刻盖章，不是确认时刻）。
        -- 确认时刻另有 confirmed_at，两者不同义。
        observed_at   TEXT NOT NULL,
        confirmed_by  TEXT REFERENCES users(id),
        confirmed_at  TEXT,

        -- 【group_id 同名不同义，特此写明】规格里这一列的本意更可能是"课题组"
        --   （同 users.group_id，全项目至今恒为 NULL 的多租户预留）。本实现把它
        --   当作"**一次输入产出的草案批次号**"（randomUUID）：同一句白话拆出来的
        --   多条草案共享一个 group_id，"确认整组"就是按它批量处理。
        --   另加一列 batch_id 会让表里出现两个都叫"组"的东西，更糟。
        group_id      TEXT NOT NULL,

        -- 提交人。规格的列清单里没有它，但没有它 proposed 行就没有归属 ——
        -- 而"我的条目"和"本人可确认自己的"两条规则都靠它。
        created_by    TEXT REFERENCES users(id),

        -- active 时指向索引里的那份文档。冲突检测按它反查已生效知识，
        -- supersede 时按它撤索引。
        -- ★ ON DELETE SET NULL 是硬要求：撤索引要 DELETE documents 那一行，
        --   若这里是默认的 NO ACTION，那条 DELETE 会被外键直接挡下来失败。
        --   撤下后条目保留、只是不再指向文档，"它曾进过索引、现已撤下"
        --   由 status='superseded' 记录。
        document_id   TEXT REFERENCES documents(id) ON DELETE SET NULL,

        -- JSON 落库说明（冲突结论 / 裁决结果 / 未做检测的原因）。
        -- 理由同 documents.ingest_note：用户可能过很久才回来看，那时响应早没了。
        note          TEXT
      );

      CREATE INDEX idx_knowledge_entries_group      ON knowledge_entries(group_id);
      CREATE INDEX idx_knowledge_entries_status     ON knowledge_entries(status, observed_at DESC);
      CREATE INDEX idx_knowledge_entries_created_by ON knowledge_entries(created_by, observed_at DESC);
      CREATE INDEX idx_knowledge_entries_document   ON knowledge_entries(document_id);
    `,
  },
  {
    version: 18,
    name: 'patrol-and-quotas',
    sql: `
      -- 阶段 6：巡检与用量治理（需求 7/8）。
      --
      -- 【巡检为什么是"比较时间戳 + 规则表"，而不是让模型判断】
      --   02 号 §2.1 把这件事定为 T3：判定规则必须**可审计、可复现** ——
      --   同一份台账跑两次要给出同一个结论。模型判断做不到这一点，而且这里
      --   根本不需要推理能力（"超过 60 天没更新"是一个减法）。
      --   所以阈值落在表里、判定落在 scan.ts 的纯函数里，两者都是确定性的。

      -- 按状态分档的巡检阈值。管理端可改（需求 8 要求阈值可配，不许硬编码）。
      CREATE TABLE patrol_rules (
        -- 受控词表，取值来自 shared 的 SUBMISSION_STATUSES
        status         TEXT PRIMARY KEY,
        -- 超过这么多天没更新就算超期
        threshold_days INTEGER NOT NULL,
        enabled        INTEGER NOT NULL DEFAULT 1,
        -- 【为什么留这一列而值恒为 'in_app'】单机部署没有邮件/Slack 基建，
        --   通知只能是应用内待办。列先占位，将来接了外部通道不必改表。
        notify_channel TEXT NOT NULL DEFAULT 'in_app',
        updated_at     TEXT NOT NULL,
        updated_by     TEXT REFERENCES users(id)
      );
      -- 默认值 = 约束 3 里用户拍的四个数字（待初审 14 / 外审 60 / 修回后再审 30 /
      -- 待上线 90）。★ 迁移发布后一个字都不能改，所以这四个数字在这里是**历史事实**；
      -- shared 的 DEFAULT_PATROL_THRESHOLDS 另存一份同值常量（供"恢复默认"与
      -- 缺行兜底），两处互相点名，防漂移。改默认值要走一条新的迁移。
      INSERT INTO patrol_rules
        (status, threshold_days, enabled, notify_channel, updated_at, updated_by) VALUES
        ('pending_initial',      14, 1, 'in_app', '2026-10-13T00:00:00.000Z', NULL),
        ('under_review',         60, 1, 'in_app', '2026-10-13T00:00:00.000Z', NULL),
        ('revision_resubmitted', 30, 1, 'in_app', '2026-10-13T00:00:00.000Z', NULL),
        ('accepted_pending',     90, 1, 'in_app', '2026-10-13T00:00:00.000Z', NULL);

      -- 待办。物化落库（而不是每次现算），因为它要留"谁在何时被通知 / 被忽略"的痕。
      CREATE TABLE patrol_tasks (
        id                  TEXT PRIMARY KEY,
        -- 预留：将来别的对象（数据集、整理计划）也能巡检，现在恒为 'submission'
        target_type         TEXT NOT NULL DEFAULT 'submission',
        target_id           TEXT NOT NULL,
        -- 投稿归属人。NULL = 阶段 1–3 的无主投稿 —— 这类待办**只有管理员看得到**，
        -- 与 submissions 那边"NULL 是公共历史数据、谁都能看"**不同义**，
        -- 原因见 repo.ts 里"为什么不套用 scopePredicate"那段。
        owner_id            TEXT REFERENCES users(id),
        -- open | dismissed | resolved（不加 CHECK，同 submissions.status 的既有口径）
        status              TEXT NOT NULL,
        -- 生成时用的阈值与超期天数：留痕。阈值后来被改了，也说得清当时按几天判的。
        threshold_days      INTEGER NOT NULL,
        overdue_days        INTEGER NOT NULL,
        -- ★ 生成时投稿的 updated_at。这是**幂等的关键**：投稿没动过就重算出同一个值，
        --   于是"这条待办已经在了"与"要按新版本重建"能分得开。
        observed_updated_at TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        -- 应用内通知：生成那一刻就算"已通知"。留列是为了将来接外部通道时
        -- 能表达"还没发出去"。
        notified_at         TEXT,
        dismissed_by        TEXT REFERENCES users(id),
        dismissed_at        TEXT,
        dismiss_reason      TEXT,
        resolved_at         TEXT
      );

      -- ★ 一条投稿最多只有一个"活着"（open 或 dismissed）的待办。
      --   局部唯一索引同时是"不会重复生成"的**结构保证**：即便 scan.ts 的
      --   幂等判断哪天写错了，这里也会在插入时直接失败，而不是悄悄堆出一串
      --   指向同一条投稿的待办。resolved 的行不在索引里，所以历史可以有很多条。
      CREATE UNIQUE INDEX idx_patrol_tasks_live
        ON patrol_tasks(target_type, target_id) WHERE status IN ('open','dismissed');
      CREATE INDEX idx_patrol_tasks_owner  ON patrol_tasks(owner_id);
      CREATE INDEX idx_patrol_tasks_status ON patrol_tasks(status);

      -- 用量配额（03 号 §7 的 A 类成本边界）：**本阶段只建表，不接线**。
      -- 【为什么不阻断】A 类的口径是"记录并告警"。把"超了就不让用"当默认，
      --   会让一个配错的阈值直接停掉实验室的问答 —— 代价与收益不成比例。
      --   默认动作因此是 record_only。user_quotas 现在没有写入路径
      --   （管理端只读展示"未设配额"），要做"按人限额"时再补写入接口。
      CREATE TABLE user_quotas (
        user_id          TEXT NOT NULL REFERENCES users(id),
        -- monthly | daily
        period           TEXT NOT NULL DEFAULT 'monthly',
        token_limit      INTEGER,
        cost_limit       REAL,
        -- 本阶段只认 'record_only' 一档
        action_on_exceed TEXT NOT NULL DEFAULT 'record_only',
        updated_at       TEXT NOT NULL,
        PRIMARY KEY (user_id, period)
      );
      -- 【为什么不建 usage_daily_summary】03 号 §7 提过可以物化一份按日汇总，
      --   但 usage/repo.ts 的既有口径是"十人量级 GROUP BY 是瞬时的"。
      --   物化汇总会与 usage_events 静默分叉（漏算一天、跨月边界……），
      --   而分叉之后的报表数字错得看不出来。按日聚合在查询时现算。
    `,
  },
  {
    version: 19,
    name: 'agent-task-resume',
    sql: `
      -- V3 / S7（X1b）：可续跑任务。Task 与 Attempt 分开：
      --   Task 是"这次调查"的长期身份；Attempt 是每次运行（含续跑）的记录。
      --   ask_records 仍是每次 run 的业务流水，本表不替代它。
      CREATE TABLE agent_tasks (
        id                     TEXT PRIMARY KEY,
        -- 与 ask_records.run_id 对应；UNIQUE 防止同一次运行建出两个任务
        run_id                 TEXT NOT NULL UNIQUE,
        -- 归属：HTTP 问答必有登录用户；匿名/评测不建任务
        owner_id               TEXT NOT NULL REFERENCES users(id),
        -- 原问题。隐私口径与 ask_records 相同（问题原文不脱敏、只对本人生效）；
        -- 不把回答正文或引用摘录存进来。
        question               TEXT NOT NULL,
        question_hash          TEXT NOT NULL,
        -- running | interrupted | partial | completed | failed | cancelled | paused
        status                 TEXT NOT NULL,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL,
        expires_at             TEXT NOT NULL,
        -- 当前活跃 attempt；NULL = 没有执行者。并发 Resume 用它做 CAS。
        active_attempt_id      TEXT,
        last_checkpoint_version INTEGER,
        -- 任务级累计预算（跨 attempt）：不能靠反复续跑突破总成本。
        cumulative_query_calls INTEGER NOT NULL DEFAULT 0,
        cumulative_tool_calls  INTEGER NOT NULL DEFAULT 0,
        cumulative_tokens      INTEGER NOT NULL DEFAULT 0,
        cumulative_cost_usd    REAL    NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_agent_tasks_owner   ON agent_tasks(owner_id);
      CREATE INDEX idx_agent_tasks_status  ON agent_tasks(status);
      CREATE INDEX idx_agent_tasks_expires ON agent_tasks(expires_at);

      CREATE TABLE agent_task_attempts (
        id                     TEXT PRIMARY KEY,
        task_id                TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
        -- running | success | timeout | aborted | model_error | exception | process_lost
        state                  TEXT NOT NULL,
        stop_reason            TEXT,
        started_at             TEXT NOT NULL,
        ended_at               TEXT,
        -- 进程崩溃/断网时没有 finally；超过这个时点就视为 process_lost。
        lease_expires_at       TEXT,
        cumulative_query_calls INTEGER NOT NULL DEFAULT 0,
        cumulative_tool_calls  INTEGER NOT NULL DEFAULT 0,
        cumulative_tokens      INTEGER NOT NULL DEFAULT 0,
        cumulative_cost_usd    REAL    NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_agent_task_attempts_task ON agent_task_attempts(task_id);

      -- 检查点只存**可重建的引用与脱敏摘要**：
      --   plan_json / evidence_json 里是子目标状态、chunkId+sourceVersion、记录 id；
      --   **不存 chunk 原文、回答正文、引用摘录**。恢复时从 documents/doc_chunks
      --   按 id+版本重新读；版本不符就丢掉并记缺口。
      CREATE TABLE agent_task_checkpoints (
        task_id              TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
        version              INTEGER NOT NULL,
        plan_json            TEXT NOT NULL,
        evidence_json        TEXT NOT NULL,
        pending_step_ids_json TEXT NOT NULL,
        query_history_json   TEXT NOT NULL,
        rewrite_rounds       INTEGER NOT NULL DEFAULT 0,
        rewrite_events_json  TEXT NOT NULL DEFAULT '[]',
        cumulative_json      TEXT NOT NULL,
        stop_reason          TEXT,
        created_at           TEXT NOT NULL,
        PRIMARY KEY (task_id, version)
      );
    `,
  },
  {
    version: 20,
    name: 'answer-feedback',
    sql: `
      -- O5：回答反馈（赞 / 踩）。
      --
      -- 【为什么 run_id 是主键，而不是 (run_id, user_id)】一次运行只属于一个
      --   提问者（ask_records.user_id），同一个人对同一次运行只能有一个态度。
      --   主键直接兑现"同一运行只有一条有效反馈"：改投是 UPDATE（覆盖），
      --   而不是再插一行让读的人去挑最新的 —— 那种表迟早会挑错。
      --
      -- 【为什么不存回答正文】沿用 v6 ask_records 的约定：回答正文与引用摘录
      --   都来自未发表材料，不复制到新的留存载体。反馈只记"这次运行被打了什么分"，
      --   要回看回答内容时按 run_id 重新走问答链路或日志。
      CREATE TABLE answer_feedback (
        run_id     TEXT    PRIMARY KEY,
        -- 反馈人。与 ask_records.user_id 应当是同一人（写入前在 handler 核对）；
        -- 单独存一份是为了**按人查**不必回表，也是"谁打的这个分"的唯一凭据。
        user_id    TEXT    NOT NULL REFERENCES users(id),
        -- up | down。不加 CHECK：词表将来若要加"中性"这一档，
        -- 而迁移一旦发布就一个字都不能改（migrations.ts 开头第 1 条）。
        rating     TEXT    NOT NULL,
        -- 踩的预设原因键（JSON 数组字符串）。赞时恒为 '[]'。
        -- 存 JSON 而不是逗号拼接：键名里将来可能带逗号。
        reasons    TEXT    NOT NULL DEFAULT '[]',
        -- 自由文字。可空；长度上限在服务端入口挡（500 字）。
        note       TEXT,
        created_at TEXT    NOT NULL,
        updated_at TEXT    NOT NULL
      );
      -- 管理端默认按"踩"筛、按时间倒序看，这是唯一的重读取路径。
      CREATE INDEX idx_answer_feedback_rating ON answer_feedback(rating, updated_at DESC);
      -- "我打过哪些分"以及按人排查。
      CREATE INDEX idx_answer_feedback_user ON answer_feedback(user_id, updated_at DESC);

      -- 导出审计（O5 决定：单一管理员导出 + 审计日志，不做双重确认）。
      --
      -- 【为什么不挂 answer_feedback 的外键】审计要回答的是"谁在什么时候导出过
      --   哪次运行"，它必须比被审计的那条反馈活得更久。挂 CASCADE 的话，
      --   将来删掉/重写反馈会连带抹掉"曾经导出过"这件事 —— 那正是审计记录的
      --   唯一用途。run_id 与 rating 存成快照，反馈改投后仍能还原当时导出的是什么。
      CREATE TABLE feedback_exports (
        id          TEXT PRIMARY KEY,
        run_id      TEXT NOT NULL,
        -- 导出那一刻的评分快照（up | down）。
        rating      TEXT NOT NULL,
        exported_by TEXT NOT NULL REFERENCES users(id),
        exported_at TEXT NOT NULL
      );
      CREATE INDEX idx_feedback_exports_time ON feedback_exports(exported_at DESC);
      CREATE INDEX idx_feedback_exports_run ON feedback_exports(run_id);
    `,
  },
  {
    version: 21,
    name: 'organize-undo',
    sql: `
      -- O6：整理撤销。
      --
      -- 【为什么动作行要加 size / mtime_ms】撤销前必须回答"目标位置那个文件还是
      --   当初被移动的那个吗"。只按路径判断不够：用户完全可能把一个同名的新文件
      --   放进去了，这时移回去就是把新文件挪走、把旧文件覆盖掉。大小 + 修改时间
      --   是移动时就能拿到、撤销时又能再核对一遍的**文件指纹**。
      --   老版本执行的动作没有这两列（NULL）→ 不允许撤销，界面如实说明原因。
      ALTER TABLE organize_actions ADD COLUMN size INTEGER;
      ALTER TABLE organize_actions ADD COLUMN mtime_ms INTEGER;

      -- execute | undo。撤销动作也记在同一个 plan 下，但**不覆盖执行记录**：
      -- 执行过的每一行原样留着，"后来又移回去了"是另一阶段的账。
      ALTER TABLE organize_actions ADD COLUMN phase TEXT NOT NULL DEFAULT 'execute';
      -- 撤销动作指向它撤的是哪一行（organize_actions.id）。
      ALTER TABLE organize_actions ADD COLUMN undo_of TEXT;

      -- 撤销结果回写在计划行上；原执行的 moved / failed_count / note 不动。
      ALTER TABLE organize_plans ADD COLUMN undone_at TEXT;
      ALTER TABLE organize_plans ADD COLUMN undone_by TEXT;
      ALTER TABLE organize_plans ADD COLUMN undo_moved INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE organize_plans ADD COLUMN undo_skipped INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE organize_plans ADD COLUMN undo_failed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE organize_plans ADD COLUMN undo_note TEXT;

      -- 撤销时按 plan + 阶段取动作；执行侧那条老索引仍按 (plan_id, ord) 工作。
      CREATE INDEX idx_organize_actions_plan_phase ON organize_actions(plan_id, phase, ord);
    `,
  },
  {
    version: 22,
    name: 'ask-run-traces',
    sql: `
      -- O7：管理端运行 Trace。一次问答一行，run_id 与 ask_records / usage_events
      -- 是同一个值 —— 三张表各答一件事：
      --   ask_records  "谁在什么时候问了什么、勾过确认没有"（业务流水）
      --   usage_events "钱花在哪一次模型调用上"（调用级流水）
      --   本表         "这次运行过程中发生了什么"（诊断快照）
      --
      -- 【只存过程元数据，不存内容】回答正文、引用摘录、证据原文、Claim 正文
      --   一律不进来。存的是工具名与查询词、命中条数、证据的 id/分数/名次、
      --   Claim 编号与判定、预算用量。要回看原文仍走既有的"查看原文"接口，
      --   那条路自己会再做一次权限校验 —— Trace 不能成为绕过权限的旁路。
      --
      -- 【为什么问题原文也不在这里】ask_records 已经有一份；再存一份就是同一段
      --   用户内容多一个留存副本，而且两份会各自演化。列表/详情按 run_id JOIN
      --   ask_records 取问题原文（LEFT JOIN：原始记录缺失时如实显示缺失）。
      CREATE TABLE ask_run_traces (
        run_id             TEXT PRIMARY KEY,
        -- 提问人。阶段 1–3 与未登录入口为 NULL，和 ask_records.user_id 同一口径。
        user_id            TEXT REFERENCES users(id),
        -- 运行开始时刻（不是落库时刻），与 ask_records.asked_at 同源。
        asked_at           TEXT NOT NULL,
        -- 业务结果：ok / timeout / model_error / exception / aborted
        outcome            TEXT NOT NULL,
        -- 诊断原因：completed / rounds / tool_calls / tokens / wall / ...
        stop_reason        TEXT NOT NULL,
        -- verified / partial / interrupted / failed
        delivery_status    TEXT NOT NULL,
        -- startup / retrieval / generation / assembly
        last_stage         TEXT NOT NULL,
        model              TEXT NOT NULL,
        -- 拼装后的 system prompt 的 sha256。只存哈希，不存提示词本身。
        prompt_hash        TEXT NOT NULL,
        -- simple / multi_source / state_lookup
        route              TEXT NOT NULL,
        duration_ms        INTEGER NOT NULL,
        -- 模型助手轮次（含未查库的收尾轮）
        turn               INTEGER NOT NULL,
        -- 终态时证据池里有多少条 / 实际渲染给模型的证据字符数
        evidence_count     INTEGER NOT NULL,
        context_chars      INTEGER NOT NULL,

        -- 以下均为 JSON 字符串，形状见 shared/trace.ts。
        -- 预算：四维额度与实际用量（limits + used）。
        budget_json        TEXT NOT NULL,
        -- 每次工具调用：name / query / hitCount / ms / isError / atMs。
        tool_trace_json    TEXT NOT NULL,
        -- 检索命中：chunkId / score / rank（不含正文）
        retrieval_hits_json TEXT NOT NULL,
        -- 进过证据池的记录：recordType / recordId
        record_evidence_json TEXT NOT NULL,
        -- 正文实际引用到的证据：id → chunkId 或 recordId
        citation_map_json  TEXT NOT NULL,
        -- Claim 校验：claimId / verdict / evidenceIds / spanEvidenceIds（不含 Claim 正文）
        claim_checks_json  TEXT NOT NULL,
        -- 引用片段校验计数：checked / passed / failed。NULL = 回落路径没有摘录可核。
        quote_checks_json  TEXT,
        -- 计划摘要：coverage / coverageRatio / 子目标 id、类型、状态、证据数
        plan_json          TEXT NOT NULL,
        rewrite_rounds     INTEGER NOT NULL,
        -- 检索改写事件：gap 原因、查询词、覆盖前后变化、停止原因
        rewrite_events_json TEXT NOT NULL,
        -- 追问改写：原问题与改写后的问题。NULL = 首轮或改写失败。
        follow_up_rewrite_json TEXT,
        warnings_json      TEXT NOT NULL,
        errors_json        TEXT NOT NULL,
        -- 落库时刻。asked_at 是运行开始，两者分开，排查时钟漂移时用得上。
        recorded_at        TEXT NOT NULL
      );

      -- 列表默认按运行时间倒序；按用户、按结果两条筛选各配一个索引。
      CREATE INDEX idx_ask_run_traces_asked ON ask_run_traces(asked_at DESC);
      CREATE INDEX idx_ask_run_traces_user ON ask_run_traces(user_id, asked_at DESC);
      CREATE INDEX idx_ask_run_traces_outcome ON ask_run_traces(outcome, asked_at DESC);
    `,
  },
  {
    version: 23,
    name: 'submission-rounds-and-ledger-fields',
    sql: `
      -- 投稿台账信息优化（docs/投稿台账类信息优化.md）：先补“稿件”这一层
      -- 的基础字段，再把“每次投向一个期刊”拆成独立的投稿轮次。
      --
      -- 【为什么不改 submissions 的既有列】现有列表、巡检、问答工具都按
      --   submissions.status / submitted_at 工作。改为“当前轮次”是一次大改，
      --   先把轮次表与字段加上、保持旧列继续表示“当前”，迁移才不会牵动
      --   阶段 1–6 的所有读取路径。以后可以再决定是否去掉冗余列。

      ALTER TABLE journals ADD COLUMN abbr TEXT;
      ALTER TABLE journals ADD COLUMN website TEXT;

      ALTER TABLE submissions ADD COLUMN algorithm_abbr TEXT;
      -- 投稿人：原表里的“负责人”。先存姓名文本，人员主档建立后再做绑定
      -- （不按姓名自动匹配 —— 重名是可能的）。
      ALTER TABLE submissions ADD COLUMN submitter_name TEXT;
      ALTER TABLE submissions ADD COLUMN submitter_user_id TEXT REFERENCES users(id);
      -- 实际进入当前状态的日历日期（YYYY-MM-DD），与 updated_at（写入时刻）分开。
      ALTER TABLE submissions ADD COLUMN status_since TEXT;

      CREATE TABLE submission_rounds (
        id                 TEXT PRIMARY KEY,
        submission_id      TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
        -- 同一篇稿件的第几次投稿；同一期刊的修回不新开轮次，转投才新开。
        round_no           INTEGER NOT NULL,
        journal_id         TEXT REFERENCES journals(id),
        -- 期刊分配的稿件编号；按文本保存，允许暂缺。
        submission_number  TEXT,
        -- 本轮次首次正式提交的日历日期（YYYY-MM-DD）。历史行保持 NULL：
        -- 旧数据只有 submitted_at 时间戳，不能凭空拆出一个“确定的日子”。
        submitted_on       TEXT,
        status             TEXT NOT NULL,
        status_since       TEXT,
        notes              TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        created_by         TEXT REFERENCES users(id)
      );

      CREATE UNIQUE INDEX idx_submission_rounds_no
        ON submission_rounds(submission_id, round_no);
      CREATE INDEX idx_submission_rounds_submission
        ON submission_rounds(submission_id, round_no DESC);

      -- 每条既有投稿回填为第 1 轮。日期保持 NULL；状态与期刊沿用主表当前值。
      INSERT INTO submission_rounds
        (id, submission_id, round_no, journal_id, submission_number, submitted_on,
         status, status_since, notes, created_at, updated_at, created_by)
      SELECT 'legacy-round-1-' || s.id, s.id, 1, s.journal_id, NULL, NULL,
             s.status, NULL, NULL, s.created_at, s.updated_at, s.user_id
        FROM submissions s;
    `,
  },
  {
    version: 24,
    name: 'people-master',
    sql: `
      -- 人员主档（docs/投稿台账类信息优化.md 第四节）。
      --
      -- 【为什么不直接扩展 users】人员是业务对象，账号是登录凭据：
      --   · 历史人员可以没有账号；
      --   · 同名不等于同一个人；
      --   · 账号绑定必须由管理员确认，不能按姓名自动匹配。
      -- 所以 id 是系统生成的稳定标识，姓名只用于展示。
      CREATE TABLE people (
        id           TEXT PRIMARY KEY,
        -- 重名允许存在；姓名不能当唯一键。
        name         TEXT NOT NULL,
        -- 学号按原样以文本保存：不转数字，避免前导零丢失。
        student_no   TEXT,
        -- 课题组。当前部署多数为空，与 users.group_id 同一口径。
        group_id     TEXT,
        -- active / graduated / left（不加 CHECK，与其它业务状态同一约定）
        status       TEXT NOT NULL DEFAULT 'active',
        -- 可选关联一个登录账号。ON DELETE SET NULL：账号删了，人员还在。
        user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
        note         TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        created_by   TEXT REFERENCES users(id)
      );

      -- 学号非空时唯一：冲突必须人工合并，不能静默造第二条。
      CREATE UNIQUE INDEX idx_people_student_no
        ON people(student_no) WHERE student_no IS NOT NULL AND student_no <> '';
      -- 一个登录账号最多绑定一条人员记录；一个人员最多绑一个账号。
      CREATE UNIQUE INDEX idx_people_user
        ON people(user_id) WHERE user_id IS NOT NULL;
      CREATE INDEX idx_people_name ON people(name);
      CREATE INDEX idx_people_status ON people(status, name);
    `,
  },
  {
    version: 25,
    name: 'patents',
    sql: `
      -- 专利：一件申请一条记录（docs/投稿台账类信息优化.md 第三节）。
      -- 它不套用论文投稿的 8 档状态：实审、公开是专利自己的流程事件。
      CREATE TABLE patents (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL,
        -- 专利号按文本保存，允许申请早期暂缺；不补零、不改写。
        patent_no           TEXT,
        -- 原表申请人姓名快照。与人员主档的关联单独一列；可空。
        applicant_name      TEXT,
        applicant_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
        -- 三个事件日期都是日历日期（YYYY-MM-DD），未知保持 NULL。
        first_submitted_on  TEXT,
        substantive_exam_on TEXT,
        published_on        TEXT,
        -- 负责人账号：用于行级可见与写权限（与投稿的 user_id 同口径）。
        owner_user_id       TEXT REFERENCES users(id),
        notes               TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        created_by          TEXT REFERENCES users(id)
      );
      CREATE INDEX idx_patents_owner ON patents(owner_user_id, updated_at DESC);
      CREATE INDEX idx_patents_name ON patents(name);

      -- 事件留痕：日期或专利号变化时追加一条，不覆盖历史。
      CREATE TABLE patent_events (
        id          TEXT PRIMARY KEY,
        patent_id   TEXT NOT NULL REFERENCES patents(id) ON DELETE CASCADE,
        -- submitted | substantive_exam | published | patent_no | renamed
        kind        TEXT NOT NULL,
        occurred_on TEXT,
        note        TEXT,
        recorded_at TEXT NOT NULL,
        recorded_by TEXT REFERENCES users(id)
      );
      CREATE INDEX idx_patent_events_patent ON patent_events(patent_id, recorded_at);
    `,
  },
  {
    version: 26,
    name: 'theses',
    sql: `
      -- 大论文题目（docs/投稿台账类信息优化.md 第五节）。
      -- 与期刊投稿分开：它是学位论文信息，不是“投了哪本刊”。
      CREATE TABLE theses (
        id          TEXT PRIMARY KEY,
        -- 关联人员主档；历史数据可能对不上，先保留姓名快照。
        person_id   TEXT REFERENCES people(id) ON DELETE SET NULL,
        author_name TEXT NOT NULL,
        -- 研究方向允许自由文本；不强行归类。
        direction   TEXT,
        title       TEXT,
        -- 成绩按学校实际口径原样保存（文本），允许未出结果。
        grade       TEXT,
        notes       TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        created_by  TEXT REFERENCES users(id)
      );
      CREATE INDEX idx_theses_person ON theses(person_id);
      CREATE INDEX idx_theses_updated ON theses(updated_at DESC);

      -- 题目变更历史：旧值 + 新值 + 时间 + 经办人，不覆盖原记录。
      CREATE TABLE thesis_title_history (
        id         TEXT PRIMARY KEY,
        thesis_id  TEXT NOT NULL REFERENCES theses(id) ON DELETE CASCADE,
        old_title  TEXT,
        new_title  TEXT,
        changed_at TEXT NOT NULL,
        changed_by TEXT REFERENCES users(id)
      );
      CREATE INDEX idx_thesis_title_history ON thesis_title_history(thesis_id, changed_at);
    `,
  },
  {
    version: 27,
    name: 'ledger-imports',
    sql: `
      -- Excel 台账导入：批次 + 逐行草稿（docs/投稿台账类信息优化.md 第七节）。
      --
      -- 【为什么草稿要落库】用户可能刷新、隔天回来继续；识别结果与原始行号
      --   必须能追溯。草稿只属于上传者（管理员可看全部），未确认前不写业务表。
      CREATE TABLE ledger_import_batches (
        id          TEXT PRIMARY KEY,
        file_name   TEXT NOT NULL,
        file_hash   TEXT NOT NULL,
        -- 私有原文件相对 data/ledger-imports 的路径。
        stored_path TEXT NOT NULL,
        uploaded_by TEXT REFERENCES users(id),
        -- draft | imported | discarded
        status      TEXT NOT NULL DEFAULT 'draft',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX idx_ledger_batches_owner ON ledger_import_batches(uploaded_by, created_at DESC);

      CREATE TABLE ledger_import_rows (
        id              TEXT PRIMARY KEY,
        batch_id        TEXT NOT NULL REFERENCES ledger_import_batches(id) ON DELETE CASCADE,
        sheet_name      TEXT NOT NULL,
        row_no          INTEGER NOT NULL,
        -- person | submission | patent | thesis
        target          TEXT NOT NULL,
        raw_json        TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        issues_json     TEXT NOT NULL,
        -- ready | needs_review | duplicate | invalid | imported | skipped
        status          TEXT NOT NULL,
        target_id       TEXT,
        result_message  TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX idx_ledger_rows_batch ON ledger_import_rows(batch_id, sheet_name, row_no);
      CREATE INDEX idx_ledger_rows_status ON ledger_import_rows(batch_id, status);
    `,
  },
  {
    version: 28,
    name: 'ledger-export-audits',
    sql: `
      -- 真实数据导出审计（投稿台账信息优化 · 第五步）。
      -- 只记“谁在什么时候导出了哪一类、按什么条件、多少行”，
      -- 不保存导出内容本身 —— 表里没有姓名、学号、成绩或正文。
      CREATE TABLE ledger_export_audits (
        id           TEXT PRIMARY KEY,
        exported_by  TEXT REFERENCES users(id),
        -- 本次请求的可见范围（own / all / 本组等），由服务端计算后写入。
        scope_json   TEXT NOT NULL,
        filters_json TEXT NOT NULL,
        row_counts_json TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_ledger_export_audits_time ON ledger_export_audits(created_at DESC);
    `,
  },
  {
    version: 29,
    name: 'ask-record-delivery-status',
    sql: `
      ALTER TABLE ask_records ADD COLUMN delivery_status TEXT
        CHECK (delivery_status IN ('verified', 'partial', 'interrupted', 'failed'));
      -- Trace 已有同一 run 的脱敏状态；旧记录能核对到的直接补齐。
      UPDATE ask_records
      SET delivery_status = (
        SELECT t.delivery_status FROM ask_run_traces AS t
        WHERE t.run_id = ask_records.run_id
      )
      WHERE EXISTS (
        SELECT 1 FROM ask_run_traces AS t WHERE t.run_id = ask_records.run_id
      );
      -- 旧版可能只按 Claim 总账写 verified；已有服务端警告时不显示绿色通过。
      UPDATE ask_records SET delivery_status = 'partial'
      WHERE outcome = 'ok' AND delivery_status = 'verified' AND warnings <> '[]';
    `,
  },
  {
    version: 30,
    name: 'submission-delete-audits',
    sql: `
      -- 误录投稿删除后保留最小审计信息，不保留整篇记录或状态历史。
      CREATE TABLE submission_delete_audits (
        id            TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL,
        title         TEXT NOT NULL,
        deleted_by    TEXT NOT NULL REFERENCES users(id),
        deleted_at    TEXT NOT NULL
      );
      CREATE INDEX idx_submission_delete_audits_time
        ON submission_delete_audits(deleted_at DESC);
    `,
  },
  {
    version: 31,
    name: 'shared-record-revisions-and-edits',
    sql: `
      ALTER TABLE submissions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE patents ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE theses ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

      -- 所有写路径（含状态流转、导入和关联清理）都推动版本。
      CREATE TRIGGER submissions_revision AFTER UPDATE ON submissions
      WHEN NEW.revision = OLD.revision
      BEGIN UPDATE submissions SET revision = OLD.revision + 1 WHERE id = NEW.id; END;
      CREATE TRIGGER patents_revision AFTER UPDATE ON patents
      WHEN NEW.revision = OLD.revision
      BEGIN UPDATE patents SET revision = OLD.revision + 1 WHERE id = NEW.id; END;
      CREATE TRIGGER theses_revision AFTER UPDATE ON theses
      WHEN NEW.revision = OLD.revision
      BEGIN UPDATE theses SET revision = OLD.revision + 1 WHERE id = NEW.id; END;

      CREATE TABLE record_edit_audits (
        id TEXT PRIMARY KEY,
        record_type TEXT NOT NULL CHECK (record_type IN ('submission', 'patent', 'thesis')),
        record_id TEXT NOT NULL,
        changes_json TEXT NOT NULL,
        changed_by TEXT REFERENCES users(id),
        changed_at TEXT NOT NULL
      );
      CREATE INDEX idx_record_edit_audits_record
        ON record_edit_audits(record_type, record_id, changed_at DESC);
    `,
  },
  {
    version: 32,
    name: 'archived-document-chunks',
    sql: `
      -- 只用于旧问答的原文链接核对；不建 FTS、不参与向量检索。
      CREATE TABLE archived_doc_chunks (
        id            TEXT PRIMARY KEY,
        doc_id        TEXT NOT NULL,
        ordinal       INTEGER NOT NULL,
        text          TEXT NOT NULL,
        page          INTEGER,
        section_path  TEXT,
        index_version INTEGER NOT NULL,
        doc_title     TEXT NOT NULL,
        material      TEXT NOT NULL,
        file_name     TEXT,
        archived_at   TEXT NOT NULL
      );
      CREATE INDEX idx_archived_doc_chunks_source
        ON archived_doc_chunks(doc_id, index_version, page, ordinal);
    `,
  },
  {
    version: 33,
    name: 'archive-follows-document-deletion',
    sql: `
      -- 知识撤回/删除文档时，历史片段也必须不可访问。
      -- v32 未给 doc_id 外键；用触发器维护已部署表，不修改旧迁移校验和。
      CREATE TRIGGER archived_doc_chunks_document_delete
      AFTER DELETE ON documents
      BEGIN
        DELETE FROM archived_doc_chunks WHERE doc_id = OLD.id;
      END;
    `,
  },
  {
    version: 34,
    name: 'recoverable-ledger-deletions',
    sql: `
      ALTER TABLE submissions ADD COLUMN deleted_at TEXT;
      ALTER TABLE patents ADD COLUMN deleted_at TEXT;
      ALTER TABLE theses ADD COLUMN deleted_at TEXT;

      CREATE TABLE ledger_deletions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('submission', 'patent', 'thesis')),
        record_id TEXT NOT NULL,
        title TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        deleted_by TEXT NOT NULL REFERENCES users(id),
        deleted_by_name TEXT NOT NULL,
        restored_at TEXT,
        restored_by TEXT REFERENCES users(id)
      );
      CREATE UNIQUE INDEX idx_ledger_deletions_active
        ON ledger_deletions(kind, record_id) WHERE restored_at IS NULL;
    `,
  },
  {
    version: 35,
    name: 'ask-answer-preview',
    sql: `ALTER TABLE ask_records ADD COLUMN answer_preview TEXT;`,
  },
  {
    version: 36,
    name: 'searchable-research-records',
    sql: `
      ALTER TABLE patents ADD COLUMN granted_on TEXT;
      ALTER TABLE submissions ADD COLUMN submitter_person_id TEXT REFERENCES people(id) ON DELETE SET NULL;
      ALTER TABLE code_assets ADD COLUMN profile TEXT;
      ALTER TABLE code_assets ADD COLUMN documentation_id TEXT REFERENCES documents(id) ON DELETE SET NULL;
      CREATE INDEX idx_submissions_submitter_person ON submissions(submitter_person_id);
    `,
  },
];
