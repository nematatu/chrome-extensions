const {test} = require('node:test');
const assert = require('node:assert/strict');
const core = require('../download-core.js');
const image = (id,url='https://s.cdninstagram.com/photo.jpg') => ({pk:id,media_type:1,image_versions2:{candidates:[{url,width:1080,height:720}]}});
test('カルーセルの未表示画像・動画を元の順序と形式で抽出する',()=>{
 const items=core.media({pk:'10',code:'POST',user:{username:'alice'},carousel_media:[image('11'),{pk:'12',media_type:2,video_versions:[{url:'https://v.fbcdn.net/small.mp4',width:320,height:240},{url:'https://v.fbcdn.net/large.mp4',width:1080,height:720}]},image('13')]});
 assert.deepEqual(items.map(v=>v.type),['image','video','image']);assert.equal(items[1].url,'https://v.fbcdn.net/large.mp4');assert.equal(items[2].index,3);
 assert.equal(core.filename(items[0]),'Instagram-High-Quality/alice_POST_01.jpg');assert.equal(core.filename(items[1]),'Instagram-High-Quality/alice_POST_02.mp4');
});
test('ストーリーの選択では現在のIDを優先する',()=>{
 const items=[...core.media(image('21'),{username:'alice',category:'stories'}),...core.media(image('22'),{username:'alice',category:'stories'})];
 assert.equal(core.select(items,{mediaId:'22'}).id,'22');assert.equal(core.filename(items[1]),'Instagram-High-Quality/alice_22_01.jpg');
});
test('動画の取得失敗をサムネイル保存に置き換えない',()=>{const items=core.media({...image('1'),media_type:2});assert.equal(items[0].type,'video');assert.ok(items[0].error);});
test('保存URLはInstagram CDNに限定する',()=>{for(const value of ['https://evil.example/a','https://cdninstagram.com.evil.example/a','file:///a','https://user:pass@s.cdninstagram.com/a'])assert.equal(core.allowedMediaUrl(value),false);assert.equal(core.allowedMediaUrl('https://s.fbcdn.net/a'),true);});
test('繰り返しカーソルや不明な終了条件を完了扱いしない',()=>{
 const seen=new Set();assert.equal(core.nextCursor({more_available:true,next_max_id:'next'},seen),'next');assert.throws(()=>core.nextCursor({more_available:true,next_max_id:'next'},seen));assert.throws(()=>core.nextCursor({items:[]},new Set()));assert.equal(core.nextCursor({more_available:false},seen),null);
 assert.equal(core.nextCursor({paging_info:{more_available:true,max_id:'clips'}},seen),'clips');
});
test('プロフィールと予約済みページを区別する',()=>{assert.equal(core.profileName('/alice/'),'alice');assert.equal(core.profileName('/alice/reels/'),'alice');for(const url of ['/','/explore/','/p/ABC/','/stories/alice/1/'])assert.equal(core.profileName(url),null);});
