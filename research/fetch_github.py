import json, os, time, urllib.request, urllib.parse
os.environ['HTTPS_PROXY']='http://127.0.0.1:7897'
os.environ['HTTP_PROXY']='http://127.0.0.1:7897'
def get(url, out):
    req=urllib.request.Request(url, headers={'User-Agent':'win2mac-research','Accept':'application/vnd.github+json'})
    with urllib.request.urlopen(req, timeout=40) as r:
        data=json.load(r)
    with open(out,'w',encoding='utf-8') as f: json.dump(data,f,ensure_ascii=False,indent=1)
    return data
queries={
 'wine_wrapper':'wine macos wrapper',
 'wineskin':'wineskin mac',
 'whisky':'whisky wine macos',
 'win2mac':'win2mac',
 'gptk':'game porting toolkit',
 'winapps':'winapps windows apps linux',
 'playonmac':'playonmac',
 'bundle':'windows app to mac wine bundle',
}
for k,q in queries.items():
    try:
        d=get('https://api.github.com/search/repositories?q='+urllib.parse.quote(q)+'&sort=stars&order=desc&per_page=8', f'research/raw/search_{k}.json')
        print(f'== {q} ==')
        for it in d.get('items',[]):
            print(f"{it['full_name']}  ★{it['stargazers_count']}  archived={it['archived']}  lang={it['language']}  {str(it['description'])[:110]}")
    except Exception as e:
        print('ERR',q,e)
    time.sleep(2)
