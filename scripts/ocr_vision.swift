import Foundation
import PDFKit
import Vision
import AppKit

let ROOT = "/Users/lopesmickael/Documents/FNEM/FO service gaz/Dossier ressources "
let OUTROOT = ROOT + "/OCR_FO-UND"
let TSV = "/tmp/fo_und_pdf_audit.tsv"
let PROG = "/tmp/ocr_vision_progress.txt"

func ocrPage(_ cg: CGImage) -> String {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["fr-FR"]
    req.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do { try handler.perform([req]) } catch { return "" }
    let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    return lines.joined(separator: "\n")
}

guard let tsv = try? String(contentsOfFile: TSV, encoding: .utf8) else {
    print("ERREUR: TSV introuvable"); exit(1)
}
var rels: [String] = []
for line in tsv.split(separator: "\n").dropFirst() {
    let cols = line.components(separatedBy: "\t")
    if cols.count >= 6 && cols[0] != "OK" {
        var rel = cols[5]
        if let r = rel.range(of: " :: ") { rel = String(rel[..<r.lowerBound]) }
        rels.append(rel)
    }
}
print("A traiter: \(rels.count)")
let fm = FileManager.default
var done = 0
for rel in rels {
    let src = ROOT + rel
    var out = OUTROOT + rel
    if let dot = out.range(of: ".", options: .backwards) { out = String(out[..<dot.lowerBound]) + ".txt" }
    if fm.fileExists(atPath: out), let a = try? fm.attributesOfItem(atPath: out), (a[.size] as? Int ?? 0) > 50 {
        done += 1; print("SKIP \(rel)"); continue
    }
    guard let doc = PDFDocument(url: URL(fileURLWithPath: src)) else { print("ERR_OPEN \(rel)"); continue }
    var text = ""
    for i in 0..<doc.pageCount {
        guard let page = doc.page(at: i) else { continue }
        let b = page.bounds(for: .mediaBox)
        let scale: CGFloat = 220.0 / 72.0
        let size = NSSize(width: b.width * scale, height: b.height * scale)
        let img = page.thumbnail(of: size, for: .mediaBox)
        var rect = NSRect(origin: .zero, size: img.size)
        guard let cg = img.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { continue }
        text += ocrPage(cg) + "\n\n"
    }
    try? fm.createDirectory(atPath: (out as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try? text.write(toFile: out, atomically: true, encoding: .utf8)
    done += 1
    let clean = text.filter { !$0.isWhitespace }
    print("DONE \(rel) pages=\(doc.pageCount) chars=\(clean.count)")
    try? "\(done)/\(rels.count)".write(toFile: PROG, atomically: true, encoding: .utf8)
}
print("OCR_TERMINE \(done)/\(rels.count)")
