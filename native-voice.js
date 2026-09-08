"use strict";
const {problem}=require("./work-protocol");
const HARD_MAX_DURATION_MS=60000;
const voiceSchema={type:"object",additionalProperties:false,required:["attachment_id"],properties:{attachment_id:{type:"string"}}};
function voiceConfiguration(maxDurationMs=HARD_MAX_DURATION_MS){
  if(!Number.isSafeInteger(maxDurationMs)||maxDurationMs<1000||maxDurationMs>HARD_MAX_DURATION_MS)throw new Error("voiceMaxDurationMs must be an integer from 1000 to 60000");
  return {enabled:true,container:"wav",codec:"pcm_s16le",sample_rate_min:8000,sample_rate_max:48000,channels:1,bits_per_sample:16,max_duration_ms:maxDurationMs,max_attachment_bytes:12*1024*1024};
}
const waveSignature=bytes=>bytes.length>=12&&bytes.toString("ascii",0,4)==="RIFF"&&bytes.toString("ascii",8,12)==="WAVE";
// PCM has no compressed frames: every aligned signed 16-bit sample is
// decodable. Validate the entire RIFF/chunk graph before deriving metadata.
function parseWave(bytes,{maxDurationMs}={}){
  const reject=()=>{throw problem(422,"invalid_voice_audio","需要完整的8000–48000Hz单声道PCM16 WAV音频");};
  if(!Buffer.isBuffer(bytes)||!waveSignature(bytes)||bytes.readUInt32LE(4)+8!==bytes.length)reject();
  let format,data,offset=12;
  while(offset<bytes.length){
    if(offset+8>bytes.length)reject();
    const name=bytes.toString("ascii",offset,offset+4),length=bytes.readUInt32LE(offset+4),start=offset+8,end=start+length,next=end+(length%2);
    if(end>bytes.length||next>bytes.length)reject();
    if(name==="fmt "){
      if(format||![16,18,40].includes(length))reject();
      const code=bytes.readUInt16LE(start),channels=bytes.readUInt16LE(start+2),sampleRate=bytes.readUInt32LE(start+4),byteRate=bytes.readUInt32LE(start+8),align=bytes.readUInt16LE(start+12),bits=bytes.readUInt16LE(start+14);
      if(channels!==1||bits!==16||sampleRate<8000||sampleRate>48000||align!==2||byteRate!==sampleRate*2)reject();
      if(code===1){if(length===40||length===18&&bytes.readUInt16LE(start+16)!==0)reject();}
      else if(code===0xfffe){
        if(length!==40||bytes.readUInt16LE(start+16)!==22||bytes.readUInt16LE(start+18)!==16||!bytes.subarray(start+24,start+40).equals(Buffer.from("0100000000001000800000aa00389b71","hex")))reject();
        const mask=bytes.readUInt32LE(start+20);if(mask!==0&&(mask&(mask-1))!==0)reject();
      }else reject();
      format={sampleRate};
    }else if(name==="data"){
      if(data||!format||length<2||length%2!==0)reject();
      data={length,start};
    }
    offset=next;
  }
  if(!format||!data||offset!==bytes.length)reject();
  const frameCount=data.length/2;
  if(maxDurationMs!==undefined&&frameCount*1000>format.sampleRate*maxDurationMs)throw problem(422,"voice_too_long",`语音消息最长${maxDurationMs/1000}秒`);
  return {container:"wav",codec:"pcm_s16le",sample_rate:format.sampleRate,channels:1,bits_per_sample:16,frame_count:frameCount,duration_ms:frameCount*1000/format.sampleRate};
}
function voiceAttachmentId(value){
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>key!=="attachment_id")||typeof value.attachment_id!=="string"||!/^attachment-[a-f0-9-]+$/.test(value.attachment_id))throw problem(422,"invalid_voice","voice只接受当前会话的attachment_id，不接受自报音频参数");
  return value.attachment_id;
}
module.exports={voiceConfiguration,parseWave,waveSignature,voiceAttachmentId,voiceSchema,HARD_MAX_DURATION_MS};
