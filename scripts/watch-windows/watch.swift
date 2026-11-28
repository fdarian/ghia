// Prints every window of a process tree that is on a display with alpha above zero, from the first sighting.
// usage: watch <root pid> [seconds]; stops when the root pid is gone or the seconds are up.
import CoreGraphics
import Foundation

guard CommandLine.arguments.count > 1, let root = Int32(CommandLine.arguments[1]), root > 1 else {
  FileHandle.standardError.write("usage: watch <root pid> [seconds]\n".data(using: .utf8)!)
  exit(2)
}
let seconds = Double(CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "86400") ?? 86400

func parent(_ pid: Int32) -> Int32 {
  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.stride
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
  if sysctl(&mib, 4, &info, &size, nil, 0) != 0 || size == 0 { return 0 }
  return info.kp_eproc.e_ppid
}

func inTree(_ pid: Int32) -> Bool {
  var current = pid
  for _ in 0..<40 {
    if current == root { return true }
    if current <= 1 { return false }
    current = parent(current)
  }
  return false
}

var ids = [CGDirectDisplayID](repeating: 0, count: 16)
var count: UInt32 = 0
CGGetActiveDisplayList(16, &ids, &count)
let displays = (0..<Int(count)).map { CGDisplayBounds(ids[$0]) }

let formatter = DateFormatter()
formatter.dateFormat = "HH:mm:ss.SSS"
let end = Date().addingTimeInterval(seconds)
var seen = Set<String>()
var treeOf = [Int32: Bool]()

// A window that lives a frame is why this polls about every millisecond.
while Date() < end {
  if kill(root, 0) != 0 { break }
  let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
  for window in windows {
    let alpha = window[kCGWindowAlpha as String] as? Double ?? 0
    let bounds = window[kCGWindowBounds as String] as? [String: Double] ?? [:]
    let rect = CGRect(x: bounds["X"] ?? 0, y: bounds["Y"] ?? 0, width: bounds["Width"] ?? 0, height: bounds["Height"] ?? 0)
    if alpha <= 0.01 || rect.width < 2 || !displays.contains(where: { $0.intersects(rect) }) { continue }
    let pid = Int32(window[kCGWindowOwnerPID as String] as? Int ?? 0)
    if treeOf[pid] == nil { treeOf[pid] = inTree(pid) }
    if treeOf[pid] != true { continue }
    let number = window[kCGWindowNumber as String] as? Int ?? 0
    let owner = window[kCGWindowOwnerName as String] as? String ?? "?"
    let layer = window[kCGWindowLayer as String] as? Int ?? 0
    let line = "window \(number) of \(owner) (pid \(pid)) alpha \(String(format: "%.2f", alpha)) level \(layer) at \(Int(rect.minX)),\(Int(rect.minY)) \(Int(rect.width))x\(Int(rect.height))"
    if seen.insert(line).inserted {
      print(formatter.string(from: Date()), line)
      fflush(stdout)
    }
  }
  usleep(1000)
}
exit(seen.isEmpty ? 0 : 1)
