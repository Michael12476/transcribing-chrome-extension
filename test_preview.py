"""A browser fixture for UI checks, not a transcription server. Run, then visit localhost:8875/panel.html (add ?setup to see the setup prompt)."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

EXTENSION = Path(__file__).parent / "extension"
FIXTURE = """
<script>
const fixtureKey = 'video-transcripts-ui-test';
let data = JSON.parse(localStorage.getItem(fixtureKey) || 'null') || {
  'record:it-demo': {id:'it-demo', title:'Un caffè a Roma', url:'https://example.com/it', language:'it', createdAt:'2026-10-02T12:00:00Z', chunks:[{original:'Buongiorno, come stai?', translation:'Good morning, how are you?', offset:0, duration:8}]},
  'record:en-demo': {id:'en-demo', title:'A walk through London', url:'https://example.com/en', language:'en', createdAt:'2026-10-01T12:00:00Z', chunks:[{original:'Good morning, how are you?', translation:'Buongiorno, come va?', offset:0, duration:8}]},
  session:{id:'it-demo',phase:'saved',pending:0,error:''}
};
const listeners = [];
function changed() { localStorage.setItem(fixtureKey,JSON.stringify(data)); listeners.forEach(fn=>fn({},'local')); }
window.chrome = {
  storage: {local:{
    get:async key=>key===null?structuredClone(data):{[key]:structuredClone(data[key])},
    set:async values=>{Object.assign(data,values);changed();},
    remove:async key=>{delete data[key];changed();}
  },onChanged:{addListener:fn=>listeners.push(fn)}},
  runtime:{sendMessage:async message=>{
    if(message.type==='check') return {type:'setup',ok:!location.search.includes('setup'),error:'No local model is set up yet.'};
    if(message.type==='start'){
      const id=crypto.randomUUID();
      const original=message.language==='it'?'Buongiorno, come stai?':'Good morning, how are you?';
      const translation=message.translate===false?'':message.language==='it'?'Good morning, how are you?':'Buongiorno, come va?';
      data['record:'+id]={id,title:'UI check video',url:'https://example.com/test',language:message.language,translate:message.translate,createdAt:new Date().toISOString(),chunks:[{original,translation,offset:0,duration:8}]};
      data.session={id,phase:'recording',pending:0,error:''};changed();return {ok:true,id};
    }
    data.session.phase='saved';changed();return {ok:true};
  }}
};
</script>
"""


class Preview(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(EXTENSION), **kwargs)

    def do_GET(self):
        if self.path.split("?")[0] != "/panel.html":
            return super().do_GET()
        page = (EXTENSION / "panel.html").read_text(encoding="utf-8")
        page = page.replace('<script src="panel.js">', FIXTURE + '<script src="panel.js">')
        body = page.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print("UI fixture only: http://127.0.0.1:8875/panel.html", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8875), Preview).serve_forever()
