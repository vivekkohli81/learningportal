import os

output_path = "/sessions/dreamy-charming-einstein/mnt/Riyansh Education Agents/learning-portal.html"

# Part 1: HTML head, CSS
part1 = '''<\!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Riyansh's Learning Portal</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:#f0f4f8;color:#1a2a3a;line-height:1.6;min-height:100vh}
:root{--pri:#4361ee;--pri-lt:#e8edff;--ok:#10b981;--ok-lt:#d1fae5;--warn:#f59e0b;--warn-lt:#fef3c7;--err:#ef4444;--err-lt:#fee2e2;--purp:#8b5cf6;--purp-lt:#ede9fe;--pink:#ec4899;--pink-lt:#fce7f3;--card:#fff;--txt:#1a2a3a;--txt2:#64748b;--bdr:#e2e8f0;--rad:12px;--shd:0 2px 8px rgba(0,0,0,.08);--shd2:0 4px 20px rgba(0,0,0,.12)}
.app{max-width:900px;margin:0 auto;padding:20px}
.header{background:linear-gradient(135deg,var(--pri),var(--purp));color:#fff;padding:24px 28px;border-radius:var(--rad);margin-bottom:20px;box-shadow:var(--shd2)}
.header h1{font-size:24px;font-weight:700}.header .sub{opacity:.85;font-size:14px;margin-top:4px}
.header .stats{display:flex;gap:16px;margin-top:16px;flex-wrap:wrap}
.chip{background:rgba(255,255,255,.2);padding:6px 14px;border-radius:20px;font-size:13px;font-weight:500}
.nav{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap}
.nav-btn{padding:10px 20px;border:2px solid var(--bdr);background:var(--card);border-radius:var(--rad);font-size:14px;font-weight:600;cursor:pointer;transition:.2s;font-family:inherit}
.nav-btn:hover{border-color:var(--pri);color:var(--pri)}.nav-btn.active{background:var(--pri);color:#fff;border-color:var(--pri)}
.card{background:var(--card);border-radius:var(--rad);padding:24px;margin-bottom:16px;box-shadow:var(--shd);border:1px solid var(--bdr)}
.card h2{font-size:18px;margin-bottom:4px}.card h3{font-size:16px;margin-bottom:8px;color:var(--pri)}.card .desc{color:var(--txt2);font-size:14px;margin-bottom:16px}
.qblock{background:#f8fafc;border:1px solid var(--bdr);border-radius:var(--rad);padding:20px;margin-bottom:16px}
.qblock .qnum{font-size:12px;font-weight:700;color:var(--pri);text-transform:uppercase;margin-bottom:8px}
.qblock .qinst{background:var(--pri-lt);border-left:3px solid var(--pri);padding:10px 14px;border-radius:0 8px 8px 0;font-size:13px;margin-bottom:14px;color:var(--pri);font-weight:500}
.qblock .qtxt{font-size:15px;margin-bottom:14px;line-height:1.7}
.qblock .passage{background:#fff;border:1px solid var(--bdr);padding:16px;border-radius:8px;margin-bottom:14px;font-size:14px;line-height:1.8}
.opts{display:flex;flex-direction:column;gap:8px}
.opt{display:flex;align-items:center;gap:12px;padding:12px 16px;border:2px solid var(--bdr);border-radius:8px;background:#fff;cursor:pointer;font-size:14px;transition:.2s;text-align:left}
.opt:hover{border-color:var(--pri);background:var(--pri-lt)}.opt.sel{border-color:var(--pri);background:var(--pri-lt);font-weight:600}
.opt.correct{border-color:var(--ok);background:var(--ok-lt)}.opt.incorrect{border-color:var(--err);background:var(--err-lt)}
.olet{width:28px;height:28px;border-radius:50%;background:var(--bdr);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0}
.opt.sel .olet{background:var(--pri);color:#fff}.opt.correct .olet{background:var(--ok);color:#fff}.opt.incorrect .olet{background:var(--err);color:#fff}
.btn{padding:12px 24px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:.2s;font-family:inherit}
.btn-p{background:var(--pri);color:#fff}.btn-p:hover{background:#3451d4}
.btn-s{background:var(--ok);color:#fff}.btn-s:hover{background:#059669}
.btn-o{background:#fff;color:var(--pri);border:2px solid var(--pri)}.btn-o:hover{background:var(--pri-lt)}
.btn-lg{padding:14px 32px;font-size:16px}.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-row{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}
.btn-ai{background:linear-gradient(135deg,#8b5cf6,#ec4899);color:#fff}.btn-ai:hover{opacity:.9}
.fb{padding:14px 18px;border-radius:8px;margin-top:12px;font-size:14px;display:none}
.fb.show{display:block}.fb.correct{background:var(--ok-lt);border:1px solid var(--ok);color:#065f46}
.fb.incorrect{background:var(--err-lt);border:1px solid var(--err);color:#991b1b}
.fb .fbt{font-weight:700;margin-bottom:4px}.fb .fbd{line-height:1.6}
.sc-sum{text-align:center;padding:30px}
.sc-circ{width:120px;height:120px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:700;margin:0 auto 16px;color:#fff}
.sc-circ.hi{background:var(--ok)}.sc-circ.mi{background:var(--warn)}.sc-circ.lo{background:var(--err)}
.sc-msg{font-size:18px;font-weight:600;margin-bottom:8px}.sc-det{color:var(--txt2);font-size:14px;margin-bottom:20px}
.dc{padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600;display:inline-block}
.dc.up{background:var(--ok-lt);color:#065f46}.dc.same{background:var(--pri-lt);color:var(--pri)}.dc.down{background:var(--warn-lt);color:#92400e}
.subj-cards{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:600px){.subj-cards{grid-template-columns:1fr}}
.subj-card{padding:24px;border-radius:var(--rad);cursor:pointer;transition:.2s;border:2px solid transparent;color:#fff}
.subj-card:hover{transform:translateY(-2px);box-shadow:var(--shd2)}
.subj-card .icon{font-size:36px;margin-bottom:12px}.subj-card h3{font-size:20px;margin-bottom:6px}.subj-card .cd{opacity:.85;font-size:13px}
.subj-card.eng{background:linear-gradient(135deg,var(--pri),#6366f1)}.subj-card.math{background:linear-gradient(135deg,var(--warn),#f97316)}
.tlist{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.tbtn{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;background:#fff;border:2px solid var(--bdr);border-radius:8px;cursor:pointer;transition:.2s;font-size:14px}
.tbtn:hover{border-color:var(--pri)}.tbtn .tn{font-weight:600}
.tbtn .tl{font-size:12px;padding:3px 10px;border-radius:12px;font-weight:600}
.tl.easy{background:var(--ok-lt);color:#065f46}.tl.med{background:var(--warn-lt);color:#92400e}.tl.hard{background:var(--purp-lt);color:#6d28d9}
.pbar-c{margin:16px 0}.pbar-l{display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px}
.pbar{height:8px;background:var(--bdr);border-radius:4px;overflow:hidden}
.pfill{height:100%;border-radius:4px;background:var(--pri);transition:width .5s}
.scaf{background:#fff;border:1px solid var(--bdr);border-radius:8px;padding:14px;margin-bottom:10px}
.scaf .sl{font-size:12px;font-weight:700;color:var(--purp);text-transform:uppercase;margin-bottom:6px}
.scaf .sh{font-size:12px;color:var(--txt2);margin-bottom:8px}
.scaf textarea{width:100%;padding:10px;border:1px solid var(--bdr);border-radius:6px;font-size:14px;font-family:inherit;min-height:60px;resize:vertical;line-height:1.6}
.scaf textarea:focus{outline:none;border-color:var(--pri)}
.gvis{background:#fff;border:1px solid var(--bdr);border-radius:8px;padding:16px;margin-bottom:14px;text-align:center}
.gvis svg{max-width:100%}
.dgrid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:600px){.dgrid{grid-template-columns:1fr}}
.dstat{padding:20px;text-align:center}.dstat .dv{font-size:28px;font-weight:700}.dstat .dl{font-size:13px;color:var(--txt2);margin-top:4px}
.hitem{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--bdr);font-size:14px}
.hitem:last-child{border-bottom:none}.hitem .hs{font-weight:600}
.hitem .hsc{padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600}
.cbar{margin-top:12px}.crow{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.clbl{width:120px;font-size:13px;font-weight:500;text-align:right}
.cbbg{flex:1;height:24px;background:var(--bdr);border-radius:4px;overflow:hidden}
.cbf{height:100%;border-radius:4px;transition:width .8s;display:flex;align-items:center;padding-left:8px;font-size:11px;color:#fff;font-weight:600}
.rgrid{display:grid;grid-template-columns:1fr;gap:10px}
.rcard{display:flex;gap:14px;padding:14px;border:1px solid var(--bdr);border-radius:8px;background:#fff;align-items:flex-start}
.rcard .ri{width:40px;height:40px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.rcard .rt{font-weight:600;font-size:14px}.rcard .rd{font-size:12px;color:var(--txt2);margin-top:2px}
.rcard a{color:var(--pri);font-size:12px;font-weight:600;text-decoration:none;margin-top:4px;display:inline-block}
.rcard a:hover{text-decoration:underline}
.rvi{border:1px solid var(--bdr);border-radius:8px;padding:16px;margin-bottom:12px;background:#f8fafc}
.rvi .rvq{font-weight:600;font-size:14px;margin-bottom:8px}
.rvi .rva{background:#fff;padding:12px;border-radius:6px;border:1px solid var(--bdr);font-size:14px;line-height:1.7;white-space:pre-wrap}
.rvi .rvr{margin-top:8px;font-size:12px;color:var(--txt2);background:var(--pri-lt);padding:8px 12px;border-radius:6px}
.tabs{display:flex;gap:4px;margin-bottom:16px;border-bottom:2px solid var(--bdr);flex-wrap:wrap}
.tab{padding:10px 18px;border:none;background:none;font-size:14px;font-weight:600;cursor:pointer;color:var(--txt2);border-bottom:2px solid transparent;margin-bottom:-2px;transition:.2s;font-family:inherit}
.tab:hover{color:var(--pri)}.tab.active{color:var(--pri);border-bottom-color:var(--pri)}
.ai-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;background:linear-gradient(135deg,#8b5cf6,#ec4899);color:#fff;margin-left:6px}
.spin{display:inline-block;width:18px;height:18px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:sp .8s linear infinite;margin-right:8px;vertical-align:middle}
@keyframes sp{to{transform:rotate(360deg)}}
.api-in{width:100%;padding:10px 14px;border:2px solid var(--bdr);border-radius:8px;font-size:14px;font-family:monospace}
.api-in:focus{outline:none;border-color:var(--pri)}
.diff-bar{display:flex;align-items:center;gap:8px;margin-bottom:16px;font-size:13px}
.diff-bar .lb{font-weight:600}
.ddots{display:flex;gap:4px}
.ddot{width:12px;height:12px;border-radius:50%;background:var(--bdr)}
.ddot.on{background:var(--pri)}.ddot.on.e{background:var(--ok)}.ddot.on.m{background:var(--warn)}.ddot.on.h{background:var(--err)}
</style>
</head>
<body>
<div class="app" id="app">
<div class="header">
  <h1 id="hTitle">Riyansh's Learning Portal</h1>
  <div class="sub" id="hSub">Choose a subject to start learning</div>
  <div class="stats" id="statsBar">
    <span class="chip" id="stStreak">Streak: 0 days</span>
    <span class="chip" id="stDone">Completed: 0</span>
    <span class="chip" id="stToday">Today: Not started</span>
  </div>
</div>
<div class="nav" id="mainNav">
  <button class="nav-btn active" onclick="go('home')">Home</button>
  <button class="nav-btn" onclick="go('english')">English</button>
  <button class="nav-btn" onclick="go('maths')">Maths</button>
  <button class="nav-btn" onclick="go('parent')">Parent Dashboard</button>
  <button class="nav-btn" onclick="go('resources')">Resources</button>
</div>
<div id="SC"></div>
</div>
<script>
'''

with open(output_path, 'w') as f:
    f.write(part1)

print(f"Part 1 written: {os.path.getsize(output_path)} bytes")

# Part 2: JavaScript - Data Store + Question Banks
part2 = r'''
// ================================================================
// DATA STORE
// ================================================================
const SK='riyansh_lp_v4';
let S={streak:0,lastDate:null,total:0,
  english:{punctuation:{lv:1,ok:0,no:0,hist:[],seen:[]},writing:{lv:1,ok:0,no:0,hist:[],seen:[]},reading:{lv:1,ok:0,no:0,hist:[],seen:[]}},
  maths:{geometry:{lv:1,ok:0,no:0,hist:[],seen:[]},problemSolving:{lv:1,ok:0,no:0,hist:[],seen:[]},number:{lv:1,ok:0,no:0,hist:[],seen:[]}},
  done:[],writing4review:[],aiQ:{},apiKey:''};

function save(){try{localStorage.setItem(SK,JSON.stringify(S))}catch(e){}}
function load(){try{let s=localStorage.getItem(SK);if(s){let p=JSON.parse(s);S=merge(S,p)}}catch(e){}
  ['english','maths'].forEach(s=>Object.keys(S[s]).forEach(t=>{if(\!S[s][t].seen)S[s][t].seen=[];}));
  if(\!S.aiQ)S.aiQ={};if(\!S.apiKey)S.apiKey='';}
function merge(a,b){let o={...a};for(let k of Object.keys(b)){if(b[k]&&typeof b[k]==='object'&&\!Array.isArray(b[k])&&a[k])o[k]=merge(a[k],b[k]);else o[k]=b[k];}return o;}
function markAct(){let t=new Date().toDateString();if(S.lastDate\!==t){let y=new Date(Date.now()-864e5).toDateString();S.streak=S.lastDate===y?S.streak+1:1;S.lastDate=t;}save();}

// Question Bank: Punctuation (15 per level)
const PQ={
1:[
{id:'p1_1',inst:"Add the correct punctuation mark at the end of this sentence.",txt:"The dog ran across the park",opts:["The dog ran across the park.","The dog ran across the park?","The dog ran across the park\!","the dog ran across the park."],cor:0,exp:"This is a statement (tells us something), so it ends with a full stop (.)."},
{id:'p1_2',inst:"Choose the sentence that uses capital letters correctly.",txt:"Which sentence is written correctly?",opts:["my name is Riyansh.","My name is Riyansh.","My Name is riyansh.","my Name Is Riyansh."],cor:1,exp:"First word = capital. Names = capital. Other words do NOT need capitals."},
{id:'p1_3',inst:"Add the correct punctuation mark at the end.",txt:"Where is the library",opts:["Where is the library.","Where is the library?","Where is the library\!","Where is the library,"],cor:1,exp:"This asks something (starts with 'Where'). Questions end with a question mark (?)."},
{id:'p1_4',inst:"Choose the sentence with correct punctuation.",txt:"Which one is correct?",opts:["i like to read books","I like to read books.","I like to read Books.","I like to read books"],cor:1,exp:"Capital letter at the start, full stop at the end. 'Books' does not need a capital."},
{id:'p1_5',inst:"What punctuation goes at the end?",txt:"Watch out for that car",opts:["Watch out for that car.","Watch out for that car?","Watch out for that car\!","Watch out for that car,"],cor:2,exp:"Someone is shouting a warning\! Strong feelings = exclamation mark (\!)."},
{id:'p1_6',inst:"Choose the correctly written sentence.",txt:"Which has the right capitals and punctuation?",opts:["the cat sat on the mat.","The Cat sat On the mat.","The cat sat on the mat.","The cat sat on the Mat"],cor:2,exp:"Only the first word needs a capital. Full stop at the end."},
{id:'p1_7',inst:"Add the correct punctuation.",txt:"How old are you",opts:["How old are you.","How old are you\!","How old are you?","How old are you,"],cor:2,exp:"Asking for information = question mark (?)."},
{id:'p1_8',inst:"Choose the correct sentence.",txt:"Which is right?",opts:["She went to the shop","She went to the Shop.","she went to the shop.","She went to the shop."],cor:3,exp:"Capital S at the start, 'shop' stays lowercase, full stop at the end."},
{id:'p1_9',inst:"Choose the correct ending.",txt:"What a beautiful sunset",opts:["What a beautiful sunset.","What a beautiful sunset?","What a beautiful sunset\!","What a beautiful sunset,"],cor:2,exp:"Expresses strong amazement = exclamation mark (\!)."},
{id:'p1_10',inst:"Which uses capital letters correctly?",txt:"Pick the correct sentence.",opts:["i went to london on monday.","I went to London on Monday.","I went to london on Monday.","I Went To London On Monday."],cor:1,exp:"'I' always capital. 'London' is a city name (capital). 'Monday' is a day (capital)."},
{id:'p1_11',inst:"Add the correct punctuation.",txt:"Please close the door",opts:["Please close the door?","Please close the door\!","Please close the door.","Please close the door,"],cor:2,exp:"A polite request ends with a full stop."},
{id:'p1_12',inst:"Choose the correct sentence.",txt:"Which uses punctuation correctly?",opts:["do you like ice cream.","Do you like ice cream.","Do you like ice cream?","Do You Like Ice Cream?"],cor:2,exp:"Question = capital letter + question mark. Middle words stay lowercase."},
{id:'p1_13',inst:"Which sentence is correct?",txt:"Someone talking about their pet.",opts:["my dog's name is max.","My dogs name is Max.","My dog's name is Max.","My Dog's Name is Max."],cor:2,exp:"'My' = capital start. 'Max' = name (capital). 'dog's' = apostrophe shows ownership."},
{id:'p1_14',inst:"Add the correct punctuation.",txt:"Today is a sunny day",opts:["Today is a sunny day,","today is a sunny day.","Today is a sunny day.","Today is a Sunny Day."],cor:2,exp:"Statement about weather. Capital start, full stop at the end."},
{id:'p1_15',inst:"Choose the correct sentence.",txt:"Which one is right?",opts:["sarah lives in hong kong.","Sarah lives in Hong Kong.","Sarah Lives In Hong Kong.","sarah Lives in Hong kong."],cor:1,exp:"'Sarah' = person name (capital). 'Hong Kong' = place name (both words capital)."}
],
2:[
{id:'p2_1',inst:"Choose correct comma use.",txt:"Which has commas in the right places?",opts:["I bought apples oranges and bananas.","I bought apples, oranges, and bananas.","I bought, apples oranges and bananas.","I bought apples oranges, and bananas."],cor:1,exp:"List of 3+ items: put a comma after each item."},
{id:'p2_2',inst:"Choose the correct apostrophe.",txt:"The ___ tail was wagging.",opts:["dogs","dog's","dogs'","dogs's"],cor:1,exp:"The tail belongs to ONE dog = dog's (apostrophe + s)."},
{id:'p2_3',inst:"Choose the correct comma use.",txt:"Which uses the comma correctly?",opts:["After dinner we watched a movie.","After dinner, we watched a movie.","After, dinner we watched a movie.","After dinner we watched, a movie."],cor:1,exp:"Time phrase at start ('After dinner') needs a comma before the main sentence."},
{id:'p2_4',inst:"Which is the correct contraction?",txt:"She ___ going to the shops.",opts:["is'nt","isn't","is not'","isnt"],cor:1,exp:"'is not' becomes 'isn't'. Apostrophe replaces the 'o'."},
{id:'p2_5',inst:"Add commas correctly.",txt:"My favourite colours are blue green red and yellow.",opts:["My favourite colours are blue green red, and yellow.","My favourite colours, are blue green red and yellow.","My favourite colours are blue, green, red, and yellow.","My favourite colours are blue, green red, and yellow."],cor:2,exp:"Every item in a list gets a comma: blue, green, red, and yellow."},
{id:'p2_6',inst:"Choose correct apostrophe use.",txt:"Which is correct?",opts:["The teachers desk was tidy.","The teacher's desk was tidy.","The teachers' desk was tidy.","The teachers desk' was tidy."],cor:1,exp:"ONE teacher's desk = teacher's (apostrophe + s after singular owner)."},
{id:'p2_7',inst:"Which comma use is correct?",txt:"Pick the right one.",opts:["However she did not agree.","However, she did not agree.","However she, did not agree.","However she did not, agree."],cor:1,exp:"Words like 'However' at the start are followed by a comma."},
{id:'p2_8',inst:"Choose the correct contraction.",txt:"We ___ be able to come tomorrow.",opts:["wo'nt","won't","will'nt","wont"],cor:1,exp:"'will not' becomes 'won't'. Irregular contraction."},
{id:'p2_9',inst:"Which uses the comma correctly with a name?",txt:"Pick the correct sentence.",opts:["Tom can you help me?","Tom, can you help me?","Tom can you, help me?","Tom can, you help me?"],cor:1,exp:"Speaking directly to someone: comma after their name (direct address)."},
{id:'p2_10',inst:"Choose the correct possessive.",txt:"The ___ toys were scattered.",opts:["childrens","children's","childrens'","children"],cor:1,exp:"'Children' is already plural. Add 's for possession = children's."},
{id:'p2_11',inst:"Which uses commas correctly?",txt:"Choose the right one.",opts:["My brother who is 10 likes football.","My brother, who is 10, likes football.","My brother who is 10, likes football.","My, brother who is 10 likes football."],cor:1,exp:"Extra info ('who is 10') is surrounded by commas on both sides."},
{id:'p2_12',inst:"Choose the correct contraction.",txt:"They ___ finished yet.",opts:["have'nt","havent","haven't","have't"],cor:2,exp:"'have not' becomes 'haven't'. Apostrophe replaces the 'o'."},
{id:'p2_13',inst:"Which apostrophe is correct?",txt:"Choose the right sentence.",opts:["Its a lovely day.","It's a lovely day.","Its' a lovely day.","Its a lovely day'."],cor:1,exp:"'It's' = 'it is'. 'Its' (no apostrophe) = belonging to it."},
{id:'p2_14',inst:"Add commas correctly.",txt:"She packed shoes socks shirts and a hat.",opts:["She packed shoes socks, shirts, and a hat.","She packed shoes, socks, shirts, and a hat.","She packed, shoes socks shirts and a hat.","She packed shoes, socks shirts, and a hat."],cor:1,exp:"Every list item gets a comma: shoes, socks, shirts, and a hat."},
{id:'p2_15',inst:"Choose the correct possessive.",txt:"The ___ bikes were outside.",opts:["boys","boy's","boys'","boys's"],cor:2,exp:"Multiple boys own the bikes. Plural ending in 's' = add apostrophe after: boys'."}
],
3:[
{id:'p3_1',inst:"Choose correctly punctuated dialogue.",txt:"Which uses speech marks correctly?",opts:["She said I am happy.",'\"She said I am happy.\"','She said, \"I am happy.\"','She said \"I am happy\"'],cor:2,exp:"Dialogue: who spoke + comma + open quotes + capital + full stop INSIDE quotes + close quotes."},
{id:'p3_2',inst:"Choose correct semicolon use.",txt:"Which uses the semicolon correctly?",opts:["I like cats; and dogs.","I like cats; dogs are also fun.","I; like cats and dogs.","I like; cats and dogs."],cor:1,exp:"Semicolon joins two complete, related sentences."},
{id:'p3_3',inst:"Choose correct dialogue punctuation.",txt:"How to write: Tom asked where are my shoes",opts:['Tom asked, \"Where are my shoes?\"','Tom asked \"where are my shoes?\"','Tom asked, \"Where are my shoes\"?','Tom asked \"Where are my shoes.\"'],cor:0,exp:"Comma after 'asked', capital W, question mark INSIDE closing quotes."},
{id:'p3_4',inst:"Which uses the colon correctly?",txt:"Choose the correct colon use.",opts:["I need: eggs milk and flour.","I need three things: eggs, milk, and flour.","I: need to buy eggs.","I need to buy: three things."],cor:1,exp:"Colon after a complete sentence to introduce a list."},
{id:'p3_5',inst:"Which has all punctuation correct?",txt:"Choose the fully correct sentence.",opts:['\"Hurry up\" shouted Mum, \"were late\!\"','\"Hurry up\!\" shouted Mum. \"We\'re going to be late\!\"','\"Hurry up\!\", shouted Mum, \"We\'re late\"\!','\"Hurry up\!\" Shouted mum. \"we\'re late\!\"'],cor:1,exp:"Exclamation inside quotes, lowercase 'shouted', 'We\\'re' with capital and apostrophe."},
{id:'p3_6',inst:"Choose correct dash use.",txt:"Which uses dashes correctly?",opts:["The answer — which surprised everyone — was wrong.","The answer which — surprised everyone — was wrong.","— The answer was wrong.","The answer — which surprised everyone was wrong."],cor:0,exp:"Dashes in pairs add extra info in the middle of a sentence."},
{id:'p3_7',inst:"Choose correct dialogue.",txt:"Which is correctly punctuated?",opts:['\"I\'m tired,\" said Emma. \"Let\'s go home.\"','\"I\'m tired\", said Emma, \"let\'s go home.\"','\"I\'m tired\" said Emma \"Lets go home.\"','\"I\'m tired.\" Said Emma. \"Let\'s go home\"'],cor:0,exp:"Comma inside quotes, lowercase 'said', full stop after name, capital L in new sentence."},
{id:'p3_8',inst:"Which semicolon use is correct?",txt:"Choose the right sentence.",opts:["She loves swimming; and running.","She loves swimming; however, she hates running.","She; loves swimming.","She loves; swimming."],cor:1,exp:"Semicolon + 'however' joins two related complete sentences."},
{id:'p3_9',inst:"Choose correct bracket use.",txt:"Which uses brackets correctly?",opts:["The Eiffel Tower (in Paris is very tall).","The Eiffel Tower (in Paris) is very tall.","The Eiffel (Tower in Paris) is very tall.","(The Eiffel Tower) in Paris is very tall."],cor:1,exp:"Brackets contain removable extra information."},
{id:'p3_10',inst:"Choose the correct punctuation.",txt:"Which is correct?",opts:['She asked, \"Do you want tea or coffee?\"','She asked \"do you want tea or coffee\"?','She asked, \"do you want tea or coffee?\"','She asked \"Do you want tea or coffee?\".'],cor:0,exp:"Comma after 'asked', capital D, question mark INSIDE closing quotes."},
{id:'p3_11',inst:"Choose correct ellipsis use.",txt:"Which uses ... correctly?",opts:["She waited... and waited... and finally, he arrived.","She... waited and waited.","She waited and waited and...","...She waited and waited."],cor:0,exp:"Ellipsis (...) shows a pause or trailing off. Creates dramatic effect between repeated phrases."},
{id:'p3_12',inst:"Choose correct punctuation.",txt:"Which is fully correct?",opts:["My three favourite cities are: London, Paris, and Tokyo.","My favourite cities are London; Paris; and Tokyo.","My favourite cities are London, Paris, and Tokyo.","My favourite cities, are London, Paris, and Tokyo."],cor:2,exp:"When the list flows naturally, no colon needed. Just commas between items."},
{id:'p3_13',inst:"Choose correct dialogue with action.",txt:"Which is right?",opts:['\"Look\!\" she pointed at the sky, \"a rainbow\!\"','\"Look\!\" She pointed at the sky. \"A rainbow\!\"','\"Look\!\" she pointed at the sky. \"A rainbow\!\"','\"Look\"\! she pointed at the sky.'],cor:2,exp:"'she' lowercase after exclamation. Full stop after action. New speech = capital A."},
{id:'p3_14',inst:"Tricky apostrophe.",txt:"Choose the correct sentence.",opts:["The Jones' house is big.","The Jones's house is big.","The Joneses' house is big.","The Jone's house is big."],cor:2,exp:"Family name 'Jones' becomes plural 'Joneses', then add apostrophe: Joneses'."},
{id:'p3_15',inst:"Choose the fully correct sentence.",txt:"A complex sentence.",opts:["Although it was raining, we went outside; however, we brought umbrellas.","Although it was raining we went outside, however we brought umbrellas.","Although, it was raining, we went outside however we brought umbrellas.","Although it was raining we went outside; however we brought umbrellas."],cor:0,exp:"Comma after intro clause, semicolon before 'however', comma after 'however'."}
]};
'''

with open(output_path, 'a') as f:
    f.write(part2)

print(f"Part 2 appended: {os.path.getsize(output_path)} bytes total")
