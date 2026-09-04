const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');

const LOGIN_URL = 'https://portal.dongyang.ac.kr/login_real.jsp?targetId=DMIS&RelayState=/';
const DMIS_ORIGIN = 'https://dmis.dongyang.ac.kr';
const ALLOWED_ORIGINS = new Set(['https://portal.dongyang.ac.kr', 'https://sso.dongyang.ac.kr', DMIS_ORIGIN]);

function checkedUrl(value, base) {
    const url = new URL(value, base);
    if (!ALLOWED_ORIGINS.has(url.origin) || url.username || url.password) {
        throw new Error('허용되지 않은 포털 이동 주소입니다.');
    }
    return url.href;
}

function nextHtmlLocation(html, base) {
    const $ = cheerio.load(html);
    const refresh = $('meta[http-equiv]').filter((_, el) => String($(el).attr('http-equiv')).toLowerCase() === 'refresh').attr('content');
    const metaUrl = refresh?.match(/url\s*=\s*(.+)$/i)?.[1]?.replace(/^["']|["']$/g, '');
    if (metaUrl) return checkedUrl(metaUrl, base);
    for (const script of $('script:not([src])').toArray()) {
        const source = $(script).html() || '';
        const match = source.match(/(?:window\.|document\.|top\.|self\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/)
            || source.match(/(?:window\.|document\.|top\.|self\.)?location\.(?:replace|assign)\(\s*["']([^"']+)["']/);
        if (match) return checkedUrl(match[1].replaceAll('\\/', '/').replaceAll('&amp;', '&'), base);
    }
    return null;
}

function requireArray(body, key, command) {
    if (!Array.isArray(body?.[key])) throw new Error(`${command} 응답의 ${key} 형식이 변경되었거나 조회가 거절되었습니다.`);
    return body[key];
}

class PortalHttpClient {
    constructor({ fetchImpl = globalThis.fetch, onRequest = () => {}, requestGate, loginTimeoutMs = 60000 } = {}) {
        this.fetchImpl = fetchImpl;
        this.requestGate = requestGate;
        this.loginTimeoutMs = loginTimeoutMs;
        this.loginSignal = null;
        this.jar = new CookieJar();
        this.onRequest = onRequest;
        this.parentKey = '';
        this.identity = null;
        this.catalog = null;
    }

    async request(url, options = {}) {
        let current = checkedUrl(url);
        let method = options.method || 'GET';
        let body = options.body;
        let contentType = options.contentType;
        for (let redirect = 0; redirect < 12; redirect += 1) {
            const cookie = await this.jar.getCookieString(current);
            let response;
            try {
                const signal = this.loginSignal
                    ? AbortSignal.any([this.loginSignal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000);
                const send = () => {
                    signal.throwIfAborted();
                    return this.fetchImpl(current, {
                        method, body, redirect: 'manual', signal,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
                            'Accept-Language': 'ko-KR,ko;q=0.9',
                            Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
                            ...(options.referer ? { Referer: checkedUrl(options.referer) } : {}),
                            ...(cookie ? { Cookie: cookie } : {}),
                            ...(contentType ? { 'Content-Type': contentType } : {}),
                            ...(method === 'POST' ? { Origin: new URL(current).origin } : {})
                        }
                    });
                };
                response = await (this.requestGate ? this.requestGate.run(send) : send());
            } catch {
                throw new Error('포털 요청이 완료되지 않았습니다. 저장 요청이었다면 재조회 후 결과를 확인하세요.');
            }
            this.onRequest({ method, origin: new URL(current).origin, path: new URL(current).pathname, status: response.status });
            for (const value of response.headers.getSetCookie()) await this.jar.setCookie(value, current);
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers.get('location');
                if (!location) throw new Error('포털 이동 응답에 주소가 없습니다.');
                const next = checkedUrl(location, current);
                // Credentials may never be replayed by a cross-origin 307/308 redirect.
                if ([307, 308].includes(response.status) && method !== 'GET' && new URL(next).origin !== new URL(current).origin) {
                    throw new Error('다른 서버로 인증 본문을 재전송하는 이동은 허용하지 않습니다.');
                }
                if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) {
                    method = 'GET'; body = undefined; contentType = undefined;
                }
                await response.body?.cancel();
                current = next;
                continue;
            }
            if (!response.ok) throw new Error(`포털 HTTP ${response.status} 오류입니다.`);
            return { url: current, text: await response.text() };
        }
        throw new Error('포털 로그인 이동 횟수를 초과했습니다.');
    }

    async navigate(url, options) {
        let page = await this.request(url, options);
        for (let index = 0; index < 8; index += 1) {
            // Only the DMIS landing page needs a scripted redirect. Other pages
            // contain conditional logout handlers that must not be followed.
            const current = new URL(page.url);
            if (current.origin !== DMIS_ORIGIN || current.pathname !== '/') return page;
            const next = nextHtmlLocation(page.text, page.url);
            if (!next || next === page.url) return page;
            if (new URL(next).pathname !== '/exsignon/sso/sso_index.jsp') throw new Error('포털 시작 페이지의 이동 형식이 변경되었습니다.');
            page = await this.request(next);
        }
        throw new Error('포털 HTML 로그인 이동 횟수를 초과했습니다.');
    }

    async json(path, payload, command) {
        const response = await this.request(new URL(path, DMIS_ORIGIN).href, {
            method: 'POST', body: JSON.stringify(payload), contentType: 'application/json; charset=UTF-8'
        });
        let data;
        try { data = JSON.parse(response.text); } catch { throw new Error(`${command} 응답이 JSON이 아닙니다. 인증 또는 점검 상태를 확인해주세요.`); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${command} 응답 형식이 올바르지 않습니다.`);
        if (data.dmMain?.errMessage || /로그인.*(종료|필요)|세션.*(종료|만료)/.test(String(data.dmMain?.strMessage || ''))) {
            throw new Error(`${command} 요청을 포털이 거절했습니다. 로그인 세션 또는 입력 조건을 확인해주세요.`);
        }
        return data;
    }

    async command(command, requestKey = null, extraData = {}) {
        if (!['OnLoad', 'FindWork', 'Chgdeptcd', 'Bef', 'List', 'Checkweek', 'Vacation', 'Holi'].includes(command)) {
            throw new Error('허용되지 않은 조회 명령입니다.');
        }
        const payload = { param: { strCommand: [command], strParentKeyValue9: [this.parentKey] } };
        if (requestKey) payload.data = { requestKey, ...extraData };
        return this.json('/sub.SubWorkSchoE.do', payload, command);
    }

    async save(requestKey, row) {
        if (this.identity?.canUpdate !== 'Y' || row.STUDENT_NO !== this.identity.studentNo
            || requestKey.strStudentNo !== this.identity.studentNo || row.sts !== 'i'
            || row.CONFIRM_YN || row.CONFIRM_DT) {
            throw new Error('본인 계정의 미승인 신규 일지만 저장할 수 있습니다.');
        }
        return this.sendRow(requestKey, row);
    }

    async change(requestKey, row) {
        const keys = ['YEAR', 'SEQ', 'SCHO_CD', 'WORK_DEPT_CD', 'WORK_DT', 'STUDENT_NO'];
        if (this.identity?.canUpdate !== 'Y' || String(row.STUDENT_NO) !== this.identity.studentNo
            || requestKey.strStudentNo !== this.identity.studentNo || !['u', 'd'].includes(row.sts)
            || String(row.CONFIRM_YN || '').toUpperCase() === 'Y' || row.CONFIRM_DT
            || keys.some((key) => !String(row[key] || '') || String(row[`${key}__origin`]) !== String(row[key]))
            || String(row.SCHO_CD) !== requestKey.strSchoCd || String(row.WORK_DEPT_CD) !== requestKey.strWorkDeptCd) {
            throw new Error('본인 미확인 일지의 원본 기본키가 일치해야 수정·삭제할 수 있습니다.');
        }
        return this.sendRow(requestKey, row);
    }

    async sendRow(requestKey, row) {
        return this.json('/sub.SubWorkSchoE.do', {
            param: {
                strCommand: ['Save'], strParentKeyValue9: [this.parentKey],
                _PATAM_AS_TABLE: ['subworkmaster,sub_work_master,dsListMain'],
                subworkmasterKEYVALUE: ['YEAR,SEQ,SCHO_CD,WORK_DEPT_CD,WORK_DT,STUDENT_NO'],
                subworkmasterKEYDATA: ['confirm_yn,confirm_dt,st_hhmi,end_hhmi,work_mi1,remark']
            },
            data: { requestKey, dsListMain: [row] }
        }, 'Save');
    }

    async login(portalId, portalPassword) {
        this.loginSignal = AbortSignal.timeout(this.loginTimeoutMs);
        try {
            return await this.#authenticate(portalId, portalPassword);
        } finally {
            this.loginSignal = null;
        }
    }

    async #authenticate(portalId, portalPassword) {
        const initial = await this.request(LOGIN_URL);
        const $ = cheerio.load(initial.text);
        const form = $('#loginFrm');
        if (!form.length || !form.find('[name="user_id"]').length) throw new Error('학교 로그인 폼 형식이 변경되었습니다.');
        const fields = new URLSearchParams();
        for (const input of form.find('input[name]').toArray()) {
            const name = $(input).attr('name');
            fields.set(name, $(input).attr('value') || '');
        }
        fields.set('user_id', portalId);
        fields.set('user_password', portalPassword);
        await this.navigate('https://portal.dongyang.ac.kr/proc/Login.do?targetId=DMIS&RelayState=/', {
            method: 'POST', body: fields.toString(), contentType: 'application/x-www-form-urlencoded', referer: initial.url
        });
        const menu = await this.json('/sys.Main.do', {
            param: { MENU_ID: ['SubWorkSchoE_SCH'], OPRT_ROLE_ID: [''], strCommand: ['MenuAuth'] }
        }, 'MenuAuth');
        this.parentKey = String(menu.dmMain?.strParentKeyValue9 || '');
        const header = await this.json('/cmn.CmnAppHeader.do', {
            param: { strCommand: ['Onload'] }, data: { dmOprtRole: { strMenuId: 'SubWorkSchoE_SCH' } }
        }, 'Header');
        const identity = requireArray(header, 'systemInfo', 'Header')[0];
        if (!identity?.PGUSER_MEMBER_NO || !identity?.PGUSER_NM) throw new Error('포털 로그인 계정 정보를 확인하지 못했습니다.');
        this.identity = { studentNo: String(identity.PGUSER_MEMBER_NO), name: String(identity.PGUSER_NM) };
        this.catalog = await this.command('OnLoad');
        requireArray(this.catalog, 'listSchoCd', 'OnLoad');
        requireArray(this.catalog, 'listWorkDeptCd', 'OnLoad');
        const permissions = requireArray(this.catalog, 'systemInfo', 'OnLoad')[0];
        this.identity.canUpdate = String(permissions?.PGAUTH_UPD_POSB_YN || '');
        return this;
    }

    requestKey(year, month, assignment = {}) {
        if (!this.identity) throw new Error('포털 로그인이 필요합니다.');
        return {
            strYear: String(month < 3 ? year - 1 : year), strMonth: String(month).padStart(2, '0'),
            strSchoCd: String(assignment.scholarshipCode || ''), strWorkDeptCd: String(assignment.workDepartmentCode || ''),
            strStudentNo: this.identity.studentNo, strStudentNm: this.identity.name,
            strStatus: '', strCheckDate: '', strworkdt: '', strnat: '', strDt: '', strNm: this.identity.name
        };
    }

    async close() {
        await this.jar.removeAllCookies();
        this.identity = null; this.catalog = null; this.parentKey = '';
    }
}

module.exports = { PortalHttpClient, checkedUrl, nextHtmlLocation, requireArray };
