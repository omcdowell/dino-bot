import SwiftUI

/// A bot's Lucide icon on its tile, drawn by the widget itself from the icon name (LucideGlyphs,
/// generated from lucide-react-native). Used when the app has not stored the bot's icon in the
/// keychain (BotIconStore), so a bot with `.bot.json` "icon" never falls back to a letter. Same
/// look as the bots home and the app-rendered tile (src/live-activity/tile.ts): glyph at 48% on a
/// rounded tile (radius 30%), `#272A29`, glyph `#fafafa`, stroke 2 on the 24-unit grid.
struct LucideTile: View {
  let glyph: Path
  var size: CGFloat

  static let tileColor = Color(red: 0x27 / 255, green: 0x2A / 255, blue: 0x29 / 255)
  static let glyphColor = Color(red: 0xFA / 255, green: 0xFA / 255, blue: 0xFA / 255)

  var body: some View {
    let scale = size * 0.48 / 24
    let offset = (size - size * 0.48) / 2
    ZStack {
      RoundedRectangle(cornerRadius: size * 0.3, style: .circular).fill(Self.tileColor)
      glyph
        .applying(CGAffineTransform(a: scale, b: 0, c: 0, d: scale, tx: offset, ty: offset))
        .stroke(Self.glyphColor, style: StrokeStyle(lineWidth: 2 * scale, lineCap: .round, lineJoin: .round))
    }
    .frame(width: size, height: size)
  }
}

enum LucidePaths {
  static let namePattern = try! NSRegularExpression(pattern: "^[A-Z][A-Za-z0-9]{0,63}$")

  /// The icon's outline on Lucide's 24-unit grid, or nil for an unknown name.
  static func glyph(_ name: String) -> Path? {
    let range = NSRange(name.startIndex..., in: name)
    guard namePattern.firstMatch(in: name, range: range) != nil,
      let data = lookup(name)
    else { return nil }
    var path = Path()
    for d in data.split(separator: "|") {
      guard let sub = SVGPathParser.parse(String(d)) else { return nil }
      path.addPath(sub)
    }
    return path.isEmpty ? nil : path
  }

  /// The `name<TAB>data` line's data.
  static func lookup(_ name: String) -> Substring? {
    let table = LucideGlyphs.table
    guard let hit = table.range(of: "\n\(name)\t") else { return nil }
    let rest = table[hit.upperBound...]
    let end = rest.firstIndex(of: "\n") ?? rest.endIndex
    return rest[..<end]
  }
}

/// SVG path data (M L H V C S Q T A Z, absolute and relative) to a SwiftUI Path. Arcs become
/// cubic Béziers. Nil on malformed data.
enum SVGPathParser {
  static func parse(_ d: String) -> Path? {
    var scanner = Scanner(Array(d.utf8))
    var path = Path()
    var current = CGPoint.zero
    var start = CGPoint.zero
    var lastControl: CGPoint? = nil  // for S / T reflection
    var lastCommand: UInt8 = 0
    var command: UInt8 = 0

    while true {
      scanner.skipSeparators()
      guard let c = scanner.peek() else { break }
      if isCommand(c) {
        command = c
        scanner.advance()
      } else if command == 0 {
        return nil
      } else if command == UInt8(ascii: "M") {
        command = UInt8(ascii: "L")  // implicit lineto after moveto
      } else if command == UInt8(ascii: "m") {
        command = UInt8(ascii: "l")
      }
      let relative = command >= UInt8(ascii: "a")
      let base = relative ? current : .zero
      func point() -> CGPoint? {
        guard let x = scanner.number(), let y = scanner.number() else { return nil }
        return CGPoint(x: base.x + x, y: base.y + y)
      }
      switch command | 0x20 {  // lowercase
      case UInt8(ascii: "m"):
        guard let p = point() else { return nil }
        path.move(to: p)
        current = p
        start = p
        lastControl = nil
      case UInt8(ascii: "l"):
        guard let p = point() else { return nil }
        path.addLine(to: p)
        current = p
        lastControl = nil
      case UInt8(ascii: "h"):
        guard let x = scanner.number() else { return nil }
        current = CGPoint(x: (relative ? current.x : 0) + x, y: current.y)
        path.addLine(to: current)
        lastControl = nil
      case UInt8(ascii: "v"):
        guard let y = scanner.number() else { return nil }
        current = CGPoint(x: current.x, y: (relative ? current.y : 0) + y)
        path.addLine(to: current)
        lastControl = nil
      case UInt8(ascii: "c"):
        guard let c1 = point(), let c2 = point(), let p = point() else { return nil }
        path.addCurve(to: p, control1: c1, control2: c2)
        lastControl = c2
        current = p
      case UInt8(ascii: "s"):
        guard let c2 = point(), let p = point() else { return nil }
        let reflect = isCubic(lastCommand) ? lastControl : nil
        let c1 = reflect.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
        path.addCurve(to: p, control1: c1, control2: c2)
        lastControl = c2
        current = p
      case UInt8(ascii: "q"):
        guard let c1 = point(), let p = point() else { return nil }
        path.addQuadCurve(to: p, control: c1)
        lastControl = c1
        current = p
      case UInt8(ascii: "t"):
        guard let p = point() else { return nil }
        let reflect = isQuad(lastCommand) ? lastControl : nil
        let c1 = reflect.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
        path.addQuadCurve(to: p, control: c1)
        lastControl = c1
        current = p
      case UInt8(ascii: "a"):
        guard let rx = scanner.number(), let ry = scanner.number(), let rot = scanner.number(),
          let large = scanner.flag(), let sweep = scanner.flag(), let p = point()
        else { return nil }
        addArc(&path, from: current, to: p, rx: rx, ry: ry, rotation: rot, large: large, sweep: sweep)
        current = p
        lastControl = nil
      case UInt8(ascii: "z"):
        path.closeSubpath()
        current = start
        lastControl = nil
      default:
        return nil
      }
      lastCommand = command
    }
    return path
  }

  private static func isCommand(_ c: UInt8) -> Bool {
    return "MmLlHhVvCcSsQqTtAaZz".utf8.contains(c)
  }

  private static func isCubic(_ c: UInt8) -> Bool {
    return c | 0x20 == UInt8(ascii: "c") || c | 0x20 == UInt8(ascii: "s")
  }

  private static func isQuad(_ c: UInt8) -> Bool {
    return c | 0x20 == UInt8(ascii: "q") || c | 0x20 == UInt8(ascii: "t")
  }

  /// SVG endpoint arc to cubic Béziers (SVG 1.1 implementation notes F.6).
  static func addArc(
    _ path: inout Path, from p0: CGPoint, to p1: CGPoint, rx rxIn: Double, ry ryIn: Double,
    rotation: Double, large: Bool, sweep: Bool
  ) {
    if p0 == p1 { return }
    var rx = abs(rxIn)
    var ry = abs(ryIn)
    if rx == 0 || ry == 0 {
      path.addLine(to: p1)
      return
    }
    let phi = rotation * .pi / 180
    let cosP = cos(phi)
    let sinP = sin(phi)
    let dx = (p0.x - p1.x) / 2
    let dy = (p0.y - p1.y) / 2
    let x1 = cosP * dx + sinP * dy
    let y1 = -sinP * dx + cosP * dy
    let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
    if lambda > 1 {
      rx *= lambda.squareRoot()
      ry *= lambda.squareRoot()
    }
    let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
    let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
    var coef = den == 0 ? 0 : (max(0, num) / den).squareRoot()
    if large == sweep { coef = -coef }
    let cxp = coef * (rx * y1 / ry)
    let cyp = coef * -(ry * x1 / rx)
    let cx = cosP * cxp - sinP * cyp + (p0.x + p1.x) / 2
    let cy = sinP * cxp + cosP * cyp + (p0.y + p1.y) / 2

    func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double {
      let a = atan2(ux * vy - uy * vx, ux * vx + uy * vy)
      return a
    }
    let theta1 = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry)
    var delta = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry)
    if !sweep && delta > 0 { delta -= 2 * .pi }
    if sweep && delta < 0 { delta += 2 * .pi }

    let segments = max(1, Int(ceil(abs(delta) / (.pi / 2))))
    let step = delta / Double(segments)
    let k = 4.0 / 3.0 * tan(step / 4)
    var t = theta1
    func pointAt(_ a: Double) -> (CGPoint, CGPoint) {
      // point and derivative direction on the rotated ellipse
      let ex = rx * cos(a)
      let ey = ry * sin(a)
      let p = CGPoint(x: cx + cosP * ex - sinP * ey, y: cy + sinP * ex + cosP * ey)
      let dxa = -rx * sin(a)
      let dya = ry * cos(a)
      let d = CGPoint(x: cosP * dxa - sinP * dya, y: sinP * dxa + cosP * dya)
      return (p, d)
    }
    for i in 0..<segments {
      let (a0, d0) = pointAt(t)
      let t2 = t + step
      let (a1, d1) = pointAt(t2)
      let c1 = CGPoint(x: a0.x + k * d0.x, y: a0.y + k * d0.y)
      let c2 = CGPoint(x: a1.x - k * d1.x, y: a1.y - k * d1.y)
      path.addCurve(to: i == segments - 1 ? p1 : a1, control1: c1, control2: c2)
      t = t2
    }
  }

  /// Number / flag reader over the path's bytes.
  struct Scanner {
    let bytes: [UInt8]
    var i = 0

    init(_ bytes: [UInt8]) { self.bytes = bytes }

    func peek() -> UInt8? { i < bytes.count ? bytes[i] : nil }
    mutating func advance() { i += 1 }

    mutating func skipSeparators() {
      while i < bytes.count, bytes[i] == 0x20 || bytes[i] == 0x2C || bytes[i] == 0x0A || bytes[i] == 0x09 || bytes[i] == 0x0D {
        i += 1
      }
    }

    /// Arc flags may be packed without separators ("0 01" or "a2 2 0 00-1.999-2").
    mutating func flag() -> Bool? {
      skipSeparators()
      guard let c = peek(), c == UInt8(ascii: "0") || c == UInt8(ascii: "1") else { return nil }
      i += 1
      return c == UInt8(ascii: "1")
    }

    mutating func number() -> Double? {
      skipSeparators()
      let s = i
      if i < bytes.count, bytes[i] == UInt8(ascii: "-") || bytes[i] == UInt8(ascii: "+") { i += 1 }
      var digits = false
      var dot = false
      while i < bytes.count {
        let c = bytes[i]
        if c >= 0x30 && c <= 0x39 {
          digits = true
          i += 1
        } else if c == UInt8(ascii: "."), !dot {
          dot = true
          i += 1
        } else {
          break
        }
      }
      if digits, i < bytes.count, bytes[i] == UInt8(ascii: "e") || bytes[i] == UInt8(ascii: "E") {
        var j = i + 1
        if j < bytes.count, bytes[j] == UInt8(ascii: "-") || bytes[j] == UInt8(ascii: "+") { j += 1 }
        if j < bytes.count, bytes[j] >= 0x30 && bytes[j] <= 0x39 {
          i = j
          while i < bytes.count, bytes[i] >= 0x30 && bytes[i] <= 0x39 { i += 1 }
        }
      }
      guard digits, let text = String(bytes: bytes[s..<i], encoding: .ascii), let v = Double(text) else {
        i = s
        return nil
      }
      return v
    }
  }
}
