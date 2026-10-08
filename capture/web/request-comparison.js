/** 请求对比：基准仅在当前页面内保存；所有值用纯文本，结果不覆盖抓包记录。 */
function comparisonGroup(field) {
  if (field.startsWith('original_request.')) return 'original';
  if (field.startsWith('request.query')) return 'query';
  if (field.startsWith('request.headers') || field.startsWith('request.cookies')) return 'headers';
  if (field.startsWith('request.body') || field.startsWith('request.form')) return 'body';
  if (field.startsWith('response.headers') || field.startsWith('response.cookies')) return 'responseHeaders';
  if (field.startsWith('response.body')) return 'responseBody';
  return 'overview';
}
class FlowComparison {
  constructor(dialog, getContext, notify) {
    this.dialog=dialog; this.getContext=getContext; this.notify=notify;
    this.baseline=null; this.sequence=0; this.group='all'; this.result=null;
    dialog.querySelector('[data-compare-close]').onclick=()=>dialog.close();
    dialog.querySelector('[data-compare-swap]').onclick=()=>{ if(this.pair) this.open(this.pair[1],this.pair[0]); };
    dialog.querySelector('[data-compare-clear]').onclick=()=>{this.baseline=null; this.updateMenus(); this.notify('已清除对比基准');};
    dialog.addEventListener('close',()=>{this.sequence++; this.result=null; this.pair=null; dialog.querySelector('[data-compare-results]').replaceChildren();});
    document.querySelectorAll('[data-compare-menu]').forEach(menu=>{
      menu.ontoggle=()=>{if(menu.open) this.updateMenus();};
      menu.querySelectorAll('[data-compare-action]').forEach(button=>{
        button.onclick=()=>{
          const context=this.getContext(menu.dataset.compareMenu);
          menu.open=false;
          if (!context?.id || !context.session) return;
          if(button.dataset.compareAction==='baseline'){
            this.baseline={session:context.session,id:context.id,url:context.flow?.url || context.id};
            this.updateMenus(); this.notify('已设为对比基准，可切换会话后对比');
          } else if(button.dataset.compareAction==='source'){
            const flow=context.flow;
            if(flow?.original_session_id && flow?.original_flow_id) this.open({session:flow.original_session_id,id:flow.original_flow_id},context);
          } else if(this.baseline) this.open(this.baseline,context);
        };
      });
    });
  }
  updateMenus() {
    document.querySelectorAll('[data-compare-menu]').forEach(menu=>{
      const context=this.getContext(menu.dataset.compareMenu);
      const valid=!!context?.id && !!context.session;
      const same=valid && this.baseline?.id===context.id && this.baseline?.session===context.session;
      const pin=menu.querySelector('[data-compare-action="baseline"]');
      pin.disabled=!valid; pin.setAttribute('aria-pressed',String(same)); pin.textContent=same ? '当前请求已设为基准' : '设为对比基准';
      const compare=menu.querySelector('[data-compare-action="compare"]');
      compare.disabled=!valid || !this.baseline || same;
      compare.title=this.baseline ? '基准：'+this.baseline.url : '先选择一条请求设为基准';
      menu.querySelector('[data-compare-action="source"]').hidden=!context?.flow?.original_session_id || !context?.flow?.original_flow_id;
    });
  }
  async open(left,right) {
    if(left.session===right.session && left.id===right.id){this.notify('请选择两条不同请求');return;}
    this.pair=[left,right]; this.result=null; this.group='all';
    const token=++this.sequence;
    const target=this.dialog.querySelector('[data-compare-results]'); target.replaceChildren(); target.textContent='正在比较…';
    this.dialog.querySelector('[data-compare-status]').textContent='只读对比，不重放请求。';
    this.dialog.querySelector('[data-compare-labels]').textContent='A 基准：'+(left.url || left.id)+'\nB 目标：'+(right.url || right.id);
    this.dialog.querySelector('[data-compare-swap]').disabled=true;
    this.dialog.querySelector('[data-compare-tabs]').replaceChildren();
    if(!this.dialog.open) this.dialog.showModal();
    try{
      const query=new URLSearchParams({other_session_id:right.session,other_flow_id:right.id});
      const response=await fetch('/api/analysis/'+encodeURIComponent(left.session)+'/'+encodeURIComponent(left.id)+'/compare?'+query);
      if(!response.ok) throw new Error('无法对比（'+response.status+'），请求可能已删除');
      const result=await response.json();
      if(token!==this.sequence || !this.dialog.open) return;
      this.result=result;
      this.dialog.querySelector('[data-compare-swap]').disabled=false;
      this.dialog.querySelector('[data-compare-labels]').textContent='A 基准：'+(result.left.url || left.url || left.id)+'\nB 目标：'+(result.right.url || right.url || right.id);
      const warnings=[...(result.warnings || [])];
      if(result.comparison_version!==2) warnings.push('当前后端为旧对比接口，协议、原始顺序及字节前缀检查需重启后生效。');
      this.dialog.querySelector('[data-compare-status]').textContent='发现 '+result.total_changes+' 项差异'+(result.limited ? '，仅展示前 100 项' : '')+'。正文仅比较有限预览，单个差异值最多显示 512 字符。 '+warnings.join(' ');
      this.render();
    }catch(error){
      if(token===this.sequence && this.dialog.open) target.textContent=error.message;
    }
  }
  render() {
    const target=this.dialog.querySelector('[data-compare-results]'); target.replaceChildren();
    const tabs=this.dialog.querySelector('[data-compare-tabs]'); tabs.replaceChildren();
    const groups={all:'全部',overview:'概览',headers:'请求头',query:'Query',body:'请求体',responseHeaders:'响应头',responseBody:'响应体',original:'原始请求'};
    for(const [key,label] of Object.entries(groups)){
      const count=this.result.changes.filter(change=>key==='all' || comparisonGroup(change.field)===key).length;
      const button=document.createElement('button'); button.type='button';button.textContent=label+' ('+count+')';
      button.classList.toggle('active',this.group===key);button.setAttribute('aria-pressed',String(this.group===key));
      button.onclick=()=>{this.group=key;this.render();};tabs.append(button);
    }
    const changes=this.result.changes.filter(change=>this.group==='all' || comparisonGroup(change.field)===this.group);
    if(!changes.length){target.textContent=this.result.total_changes ? '此分区没有已展示的差异。' : '已比较范围内未发现差异；请留意预览和采集限制。';return;}
    const table=document.createElement('table');table.className='comparison-table';
    const head=document.createElement('thead'); const row=document.createElement('tr');
    for(const text of ['字段 / 变化','A 基准','B 目标']){const th=document.createElement('th');th.textContent=text;row.append(th);}
    head.append(row);table.append(head);
    const body=document.createElement('tbody');
    for(const change of changes){
      const row=document.createElement('tr');
      const kind=change.kind || (change.before===null ? 'added' : change.after===null ? 'removed' : 'modified');row.dataset.kind=kind;
      const name=document.createElement('th');name.scope='row'; name.textContent=change.field+'\n'+({added:'新增',removed:'删除',modified:'修改'}[kind] || kind)+(change.value_limited || change.excerpt ? ' · 值仅显示片段' : '');
      row.append(name);
      for(const side of ['before','after']){
        const cell=document.createElement('td'); const value=document.createElement('pre');
        value.textContent=change[side+'_present']===false ? '（不存在）' : change[side]===null ? 'null / 未提供' : typeof change[side]==='string' ? change[side] : JSON.stringify(change[side]);
        cell.append(value);row.append(cell);
      }
      body.append(row);
    }
    table.append(body);target.append(table);
  }
}
