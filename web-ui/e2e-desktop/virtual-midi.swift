// 仮想の MIDI ポート (鍵盤の代わり) を作る。本物の窓のテスト (smoke.test.ts「MIDI 入力」) が使う。
//
// 使い方: swift virtual-midi.swift <ポートの名前>
//
// - 作れたら「ready」、作れなかったら「failed <状態>」を 1 行出す
// - 標準入力の 1 行「note <高さ>」ごとに、その鍵盤を押して離し、「sent <高さ>」を出す
// - 標準入力が閉じたら、ポートを消して終わる (テストが途中で落ちても、ポートを残さない)
import CoreMIDI
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let name = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "bunri-e2e"
var client = MIDIClientRef()
var source = MIDIEndpointRef()
var status = MIDIClientCreate("\(name)-client" as CFString, nil, nil, &client)
if status == 0 {
    status = MIDISourceCreate(client, name as CFString, &source)
}
guard status == 0 else {
    print("failed \(status)")
    exit(1)
}
print("ready")

func send(_ bytes: [UInt8]) {
    var list = MIDIPacketList()
    var packet = MIDIPacketListInit(&list)
    packet = MIDIPacketListAdd(&list, 1024, packet, 0, bytes.count, bytes)
    MIDIReceived(source, &list)
}

while let line = readLine() {
    let words = line.split(separator: " ")
    guard words.count == 2, words[0] == "note", let pitch = UInt8(words[1]), pitch < 128 else { continue }
    send([0x90, pitch, 100])
    usleep(120_000)
    send([0x80, pitch, 0])
    print("sent \(pitch)")
}
MIDIEndpointDispose(source)
