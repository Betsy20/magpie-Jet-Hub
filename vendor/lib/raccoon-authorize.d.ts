/**
 * Raccoon Work 的**浏览器授权**登录（官方客户端自己的那条链）。
 *
 * ## 为什么要有这个模块
 *
 * 官方桌面端 2026-11-05 的构建**不再走扫码确认页**：它开的是 `/authorize`
 * 授权页（系统浏览器），用户在**网页里**完成登录（手机号 / 微信扫码 —— 那是
 * 页面自己的一张**活的**二维码，与已死的 `/login/mp` 不是同一张），
 * 确认后页面申请一枚**一次性** `authorization_code`，再把它**投递回调用方**：
 * 要么是注册过的 `office-raccoon://` 自定义协议（只有官方 App 能收），
 * 要么是 **`127.0.0.1:<port>` 上的回环接收端**（Windows/Linux 兼容形态，
 * 第三方可以自己托管）。
 *
 * ⚠️ **本仓为什么必须走回环形态**：`office-raccoon://` 是宿主 Node 进程
 * **收不到**的自定义协议回调。而本仓原先的扫码链**已经死了** ——
 * 扫码确认页 `/login/mp` 自 2026-11-04 起**全部 404**（含微信 UA），
 * 而**签发本身是成功的** ⇒ 用户扫进去只看到一个 404 页，零报错。
 * 本模块是那半条死链的**替代**：官方客户端的授权页 + 回环接收端 + 换码。
 *
 * ## 机制参照，不是抄端口
 *
 * 线上的事实取自三处（2026-11-17 实测）：
 *
 * 1. 官网 `/authorize` 页**在线**（HTTP 200，且把它收到的
 *    `login_source` / `appname` / `desktop_callback` / `redirect` / `state`
 *    **原样回显**进页面上下文）；
 * 2. 该页 chunk 里的**解析器规则**（见下「官方页自己的规则」）；
 * 3. 换码端点 `POST /api/web/auth/v1/login_with_authorization_code` ——
 *    实测一枚瞎编的 code 回 **HTTP 400 `{code:200035}`**（= 官方常量
 *    `AUTHORIZATION_CODE_NOT_FOUND`），证明端点与错误码都还在。
 *
 * ## 官方页自己的规则（我们逐条前置校验）
 *
 * 页面的解析器（chunk `app/(identity)/authorize/page-…js`）要求：
 *
 * - `redirect` 必须匹配 `^http://127\.0\.0\.1:[1-9][0-9]{3,4}/auth/callback$`
 *   （端口 4~5 位、首位非 0），且端口落在 1024..65535；
 * - `state` 必须是 **64 位小写 hex**；
 * - `login_source` 存在时**必须**是 `desktop`；
 * - `desktop_callback` 存在时**必须**是 `loopback`，且此时
 *   `login_source` 必为 `desktop`、`ide` 必为空、`redirect` 必过上面那条；
 * - 参数名**只能**取自 `{login_source, appname, state, redirect, ide, org,
 *   lang, desktop_callback}` —— 多一个键整条链接就作废。
 *
 * ⇒ 一个页面会拒收的 URL **不该**拿给用户（那是个没有下一步的死路）。
 * 所以 {@link buildRaccoonAuthorizeUrl} 在**发出之前**就按这些规则自查。
 *
 * ## 回环接收端的七条规则（官方接收端的规则逐条重述）
 *
 * 授权码是一次性凭据，而一个敞开的接收端就是「凭据交换漏洞」 ⇒ 七条检查
 * **一条都不能少**：GET-only、`Host` 等于我们自己的 authority、来源地址是
 * 回环、存在的 `Origin` 必须等于网关 origin、存在的 `Sec-Fetch-Dest`
 * 必须是 `document`、路径与查询键严格受限、`state` 常量时间比对通过。
 *
 * ## 凭据的边界
 *
 * 换码的结果**只**回到调用方（换码成功后由登录页流程落进 DSH 凭据服务）。
 * 本模块**不打印**任何凭据值：失败结果只带**原因词**，不带报文原文
 * （报文可能回显那枚 code）。
 *
 * @module dsh-providers-hub/raccoon-authorize
 */
import { RACCOON_API_BASE, type RaccoonCredential } from './raccoon.js';
import { type RaccoonProduct } from './raccoon-product.js';
/**
 * 网关 origin —— 本模块构造的每条 URL 都以它为底。
 *
 * ⚠️ **重导出**（不是只 import）：调用方与测试都要拿它当「授权页 origin」和
 * 「`Origin` 头必须等于的那个值」，而这个模块**就是**这条链的定义处 ⇒
 * 从这里导出才是**单一真相源**（从别处 import 会让「改了常量、这边没改」
 * 成为可能）。
 */
export { RACCOON_API_BASE };
/** 官方客户端在系统浏览器里打开的授权页路径。 */
export declare const RACCOON_AUTHORIZE_PATH = "/authorize";
/**
 * 回环接收端的回调路径 —— **由官方页面写死**，不可改。
 *
 * 页面投递时用的参数名在 desktop 形态下是 **`code`**（非 desktop 才是
 * `authorization_code`；见页面 chunk 的
 * `r.searchParams.set(e.desktop ? "code" : "authorization_code", t)`）。
 */
export declare const RACCOON_LOOPBACK_CALLBACK_PATH = "/auth/callback";
/**
 * 授权页上显示的「申请授权的应用」名。
 *
 * 官方客户端自己的 `DESKTOP_AUTH_PARAMS` 字面量（desktopLogin.js），
 * 也是 2026-11-17 那次真机授权**成功走完**时用的名字。
 *
 * ⚠️ 官方页的解析器对三个 appname 有白名单（办公小浣熊客户端 / 商汤小浣熊
 * 客户端 / Office Raccoon），其余名字**也能解析**，但确认文案会照抄
 * 那个**未知字符串** ⇒ 页面上一句「此应用希望使用你的账号登录」会变成
 * 一句没头没尾的话。故默认用**实测走通的那个**。
 */
export declare const RACCOON_AUTH_APPNAME = "\u529E\u516C\u5C0F\u6D63\u718A\u5BA2\u6237\u7AEF";
/**
 * 网关的「这枚授权码不存在 / 已过期 / 已消费」错误码。
 *
 * 实测（2026-11-17）：一枚瞎编的 code 打
 * `POST /api/web/auth/v1/login_with_authorization_code` ⇒ HTTP 400
 * `{"code":200035,"message":"authorization_code_not_found_error"}`。
 * 官方客户端的常量 `AUTHORIZATION_CODE_NOT_FOUND` 是**同一个值**。
 *
 * ⚠️ 这是**唯一**的出路：重发同一枚码没有任何用处，只能**重开一轮**。
 */
export declare const RACCOON_AUTHORIZATION_CODE_NOT_FOUND = 200035;
/**
 * 回环等待的默认时限（毫秒）。
 *
 * 官方回环自己的默认值（`timeoutMs ?? 300000`）。一次「网页里重新登录」
 * （含手机号验证码）能从容落在这五分钟内。
 */
export declare const RACCOON_AUTHORIZE_TIMEOUT_MS: number;
/**
 * IAM 令牌必须带的 `iss`。
 *
 * 官方客户端算的是 `new URL(LOGIN_URL).host + "/iam"` —— **裸 host、无 scheme**。
 * ⚠️ **无 scheme 这件事是承重的**：`iss` 是**等值**比较，若按带 scheme 的
 * 严格等值去比，会**误拒每一枚真令牌**。
 */
export declare const RACCOON_IAM_ISSUER: string;
/**
 * 回调 URL 的**总长度上限**。
 *
 * ## 为什么是 4096 而不是官方的 8192
 *
 * 官方接收端写的是 `rawUrl.length > 8192`。但**在我们这儿那个上限是够不着的**：
 * Node 的 `maxHeaderSize: 8192`（**含**请求行与方法/版本/Host 等头）在 URL
 * 长到约 **8160** 时就会先回 **431 Request Header Fields Too Large**
 * （实测：URL 长 8150 → 200、8160 → 431）⇒ **任何长于 8192 的 URL 根本到不了
 * 我们的处理器** ⇒ 写 8192 等于**一条永远走不到的死代码**（本仓反复记过
 * 「判据够不着 ⇒ 等于没有」）。
 *
 * ⇒ 取 **4096**：既**真的**在 Node 的 431 之前（⇒ 这条判据**有牙**、
 * 能被单测打到），又远高于任何**正常**回调的长度
 * （路径 13 + `code` ≤ 4096 + `state` 64 + 分隔符 ≈ 4200 —— 嗯，正好在
 * 边界上，所以 code 那条 4096 的上限与它**同量级**，两条腿合起来把
 * 「畸形超长」挡在门外）。
 *
 * ⚠️ 代价要说清：**一条 code 极长（接近 4096）的合法回调**可能被这条 URL
 * 上限拒掉。但那种 code 上游自己也不会签发（官方对 code 的上限也是 4096，
 * 而带 64 位 state 与路径后总量必然更小）⇒ 实际不可达。
 */
export declare const RACCOON_CALLBACK_URL_MAX_LENGTH = 4096;
/**
 * 单个 socket 的空闲超时（毫秒）—— 官方接收端同款（20000）。
 *
 * ⚠️ **可注入**（`options.socketTimeoutMs`）：20 秒在单测里没法等 ⇒
 *   没有注入点，那条判据就**够不着**（变异验证会如实报「无牙」——
 *   那不是判据没用，是**够不着**）。
 */
export declare const RACCOON_SOCKET_TIMEOUT_MS = 20000;
/**
 * 判断一枚令牌**是不是** IAM 形态 —— 官方 `iamToken.js` 的规则：
 * `iss` 以 `/iam` 结尾。
 *
 * ⚠️ **不验签**：签名由服务端负责校验；这里只决定**走成功门的哪一半**。
 *
 * @param token - 候选 JWT。
 * @returns 是否 IAM 形态。
 */
export declare function isRaccoonIamToken(token: unknown): boolean;
/**
 * 官方 `iamTokenIsValid` 的重述：同一个 issuer、非空 `sub`、未来的有限 `exp`
 * —— 且 `exp` 不能大到让 `new Date(exp*1000)` 不是一个日期。
 *
 * @param token - access token。
 * @param issuer - 期望的 `iss`（默认 {@link RACCOON_IAM_ISSUER}）。
 * @returns 是否通过。
 */
export declare function raccoonIamTokenIsValid(token: unknown, issuer?: string): boolean;
/**
 * 构造「一次浏览器登录」打开的那条 URL。
 *
 * 每个参数都在**发出之前**按官方页面的规则自查（见文件头「官方页自己的
 * 规则」）；不合规就**抛错**（带名字），让调用方能给出一句有下一步的话，
 * 而不是丢一个页面会拒收的链接给用户。
 *
 * @param options
 * @param options.port - 回环端口（整数 1024..65535）。
 * @param options.state - 64 位小写 hex 的 state（公开的 CSRF 令牌）。
 * @param options.appname - 授权页显示的应用名（默认 {@link RACCOON_AUTH_APPNAME}）。
 * @param options.base - 网关 origin（默认 {@link RACCOON_API_BASE}）。
 * @returns 完整 URL。
 * @throws {Error} 具名的违规说明。
 */
export declare function buildRaccoonAuthorizeUrl({ port, state, appname, base, }: {
    port: unknown;
    state: unknown;
    appname?: unknown;
    base?: unknown;
}): string;
/** 回环接收端的终态。 */
export interface RaccoonAuthorizeReceiverResult {
    /** 是否拿到了授权码。 */
    ok: boolean;
    /** 授权码**只**在这里出现（不进响应体、不进日志）。 */
    code?: string;
    /** 失败的原因词。 */
    reason?: 'timeout' | 'closed' | 'failed';
}
/** 一个活着的回环接收端及其归宿。 */
export interface RaccoonAuthorizeReceiver {
    /** 接收端期待的 state（64 hex，公开）。 */
    state: string;
    /** 实际监听的端口。 */
    port: number;
    /** `/authorize` URL 携带的回跳目标。 */
    redirect: string;
    /** 要在系统浏览器里打开的完整 `/authorize` URL。 */
    authorizeUrl: string;
    /** 只落定一次：回调带来的 code，或终态原因。 */
    result: Promise<RaccoonAuthorizeReceiverResult>;
    /** 立刻关闭接收端（结果落定为 `{ok:false, reason:'closed'}`）。 */
    cancel: () => void;
}
/**
 * 启动回环接收端 —— 官方 `/authorize` 页的回调落点。
 *
 * 工厂是**异步**的：端口只有在操作系统分配之后才知道（`port 0`），调用方
 * 必须在把 URL 交给浏览器**之前** await 它 —— 那时接收端**已经在听**，
 * 不存在「页面往一个还不是我们的端口上跳」的窗口。
 *
 * ⚠️ 绑不上端口（EADDRINUSE）**不抛**：调用方正处在一个请求里、需要一句
 * 答复，而它报出来的失败是用户**能动作**的（重开一轮）。
 *
 * @param options
 * @param options.port - 指定端口；缺省 / 0 = 由操作系统分配。
 * @param options.state - 64 位 hex；缺省时随机生成。
 * @param options.timeoutMs - 等待时限（默认 {@link RACCOON_AUTHORIZE_TIMEOUT_MS}）。
 * @param options.authorizationOrigin - 存在的 `Origin` 头必须等于它（默认网关 origin）。
 * @param options.appname - 授权页的应用名。
 * @param options.base - 网关 origin。
 * @returns 接收端句柄。
 */
export declare function startRaccoonAuthorizeReceiver(options?: {
    port?: unknown;
    state?: unknown;
    timeoutMs?: unknown;
    authorizationOrigin?: unknown;
    appname?: unknown;
    base?: unknown;
    /** 单个 socket 的空闲超时（毫秒）；默认 {@link RACCOON_SOCKET_TIMEOUT_MS}。 */
    socketTimeoutMs?: unknown;
}): Promise<RaccoonAuthorizeReceiver>;
/**
 * 用系统默认浏览器打开 URL；**永不抛出**。
 *
 * ⚠️⚠️ **绝不能用 `cmd /c start`** —— 它把 URL 里每个 `&` 当命令分隔符，
 * 于是 `?...&...` 会被**截断**在第一个 `&` 上（症状极具误导性：授权页显示
 * 「链接无效」、参数全丢）。`rundll32` **不经过 shell**，参数原样传递
 * （与 `accio-oauth.ts` 的 `openBrowser` 同一处方）。
 *
 * ⚠️ 永不抛出的兑现方式是那个**空回调**：Node 只在 `execFile` **带回调**时
 * 才代为挂上 `'error'` 监听器 ⇒ 那个 `() => {}` 不是装饰，删掉它，
 * `ENOENT` 会变成**未捕获异常**并打挂宿主进程。
 */
export declare function openRaccoonAuthorizePage(url: string): void;
/** 换码的结果。 */
export interface RaccoonAuthorizeExchange {
    /** 是否换到了可用的一对凭据。 */
    ok: boolean;
    /** 拒绝的原因词（**没有**报文原文：报文可能回显那枚 code）。 */
    reason?: 'code_not_found' | 'session_dead' | 'server_error' | 'network' | 'invalid_response' | 'refresh_missing' | 'token_invalid';
    /** 换到的凭据（仅 `ok` 时存在）。 */
    credential?: RaccoonCredential;
}
/**
 * 用一次性授权码换凭据。
 *
 * 请求形状与官方**逐字节相同**：`POST {authApi}/login_with_authorization_code`，
 * 只带一个 `Content-Type` 头，body 是 `{ authorization_code }`。
 * 网关的 web-auth 这一族用的是**数字** `code === 0` 信封。
 *
 * ## 成功门（官方的那道门，逐字重述）
 *
 * 必须有 `access_token`，**并且**满足**二者之一**：
 *
 * - 一枚**有效**的 IAM 令牌（官方规则：同一 issuer + 非空 `sub` + 未来的
 *   `exp`）—— 这一半**不要求**带 refresh；
 * - 或一枚 refresh token（legacy 那一对）。
 *
 * 差一点就是**拒绝 + 具名原因**，**绝不**产出半截凭据（存下半个凭据 = 存下
 * 一个轮换之后什么都不剩的东西）。
 *
 * ⚠️ 上面第一半（IAM 令牌）**不要求** refresh ⇒ 那种凭据落库后
 * `isRaccoonRefreshable()`（`src/raccoon.ts`）为 **false**，账号**不可静默续期**：
 * 续期调度器跳过它（`src/raccoon-auth.ts` 的 `if (!entry.refreshable) continue`），
 * 而推理侧遇到 401/403 时 `refresh()` 会**在发任何网络请求之前**抛
 * `RefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')`。
 * 这是**有意的**（官方规则如此，且行为诚实、不白烧凭据），但后果用户可见：
 * **到期后必须重新登录**。
 *
 * @param code - 一次性授权码（最多换一次；上游会对重放回 400）。
 * @param options
 * @param options.product - 产品配置（默认 {@link RACCOON}）。
 * @param options.fetcher - 注入的 fetch（测试用）。
 * @param options.authApiBase - 换码端点前缀（默认取 `product`）。
 * @param options.iamIssuer - IAM 令牌必须带的 `iss`（默认 {@link RACCOON_IAM_ISSUER}）。
 * @param options.signal - 调用方自带的取消信号（缺省时用请求超时）。
 * @returns 换码结果。
 */
export declare function exchangeRaccoonAuthorizationCode(code: unknown, options?: {
    product?: RaccoonProduct;
    fetcher?: typeof fetch;
    authApiBase?: unknown;
    iamIssuer?: unknown;
    /** 调用方自带的取消信号（缺省时挂 {@link RACCOON_REQUEST_TIMEOUT_MS} 的截止时间）。 */
    signal?: AbortSignal;
}): Promise<RaccoonAuthorizeExchange>;
//# sourceMappingURL=raccoon-authorize.d.ts.map