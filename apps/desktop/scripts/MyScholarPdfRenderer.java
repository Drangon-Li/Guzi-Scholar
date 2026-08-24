import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.Writer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import javax.imageio.ImageIO;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDFontDescriptor;
import org.apache.pdfbox.pdmodel.graphics.color.PDColor;
import org.apache.pdfbox.contentstream.operator.color.SetNonStrokingColorN;
import org.apache.pdfbox.contentstream.operator.color.SetNonStrokingColorSpace;
import org.apache.pdfbox.contentstream.operator.color.SetNonStrokingDeviceCMYKColor;
import org.apache.pdfbox.contentstream.operator.color.SetNonStrokingDeviceGrayColor;
import org.apache.pdfbox.contentstream.operator.color.SetNonStrokingDeviceRGBColor;
import org.apache.pdfbox.contentstream.operator.color.SetStrokingColorN;
import org.apache.pdfbox.contentstream.operator.color.SetStrokingColorSpace;
import org.apache.pdfbox.contentstream.operator.color.SetStrokingDeviceCMYKColor;
import org.apache.pdfbox.contentstream.operator.color.SetStrokingDeviceGrayColor;
import org.apache.pdfbox.contentstream.operator.color.SetStrokingDeviceRGBColor;
import org.apache.pdfbox.rendering.ImageType;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.pdfbox.text.TextPosition;
import org.apache.pdfbox.util.Matrix;
import org.apache.pdfbox.util.Vector;

public final class MyScholarPdfRenderer {
    private MyScholarPdfRenderer() {}

    public static void main(String[] args) throws Exception {
        if (args.length == 3 && "--evidence".equals(args[0])) {
            writeEvidence(Path.of(args[1]), Path.of(args[2]));
            return;
        }
        if (args.length == 4) {
            renderPages(args);
            return;
        }
        if (args.length == 3 && "--crop".equals(args[0])) {
            renderCrops(Path.of(args[1]), Path.of(args[2]));
            return;
        }
        throw new IllegalArgumentException(
            "expected --evidence input.pdf output.json, input.pdf output-dir dpi page-count, or --crop input.pdf crop-manifest.tsv"
        );
    }

    private static final int MAX_EVIDENCE_PAGES = 512;
    private static final int MAX_EVIDENCE_SPANS = 200_000;
    private static final int MAX_EVIDENCE_TEXT_CHARS = 4_000_000;
    private static final float BOLD_STEM_WIDTH = 100.0f;

    private static final class EvidenceChar {
        private final String text;
        private final float left;
        private final float top;
        private final float right;
        private final float bottom;

        private EvidenceChar(String text, float left, float top, float right, float bottom) {
            this.text = text;
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
        }
    }

    private static final class EvidenceSpan {
        private String text;
        private final float top;
        private float right;
        private final float bottom;
        private final float size;
        private final String font;
        private final boolean bold;
        private final int color;
        private final float left;
        private final List<EvidenceChar> chars = new ArrayList<>();

        private EvidenceSpan(
            String text,
            float left,
            float top,
            float right,
            float bottom,
            float size,
            String font,
            boolean bold,
            int color,
            EvidenceChar character
        ) {
            this.text = text;
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
            this.size = size;
            this.font = font;
            this.bold = bold;
            this.color = color;
            if (character != null) {
                chars.add(character);
            }
        }

        private boolean canAppend(
            String nextText,
            float nextLeft,
            float nextTop,
            float nextSize,
            String nextFont,
            boolean nextBold,
            int nextColor
        ) {
            if (nextText.isEmpty() || text.length() + nextText.length() > 1024
                || color != nextColor || bold != nextBold || !font.equals(nextFont)) {
                return false;
            }
            float lineTolerance = Math.max(2.0f, Math.min(size, nextSize) * 0.35f);
            float gap = nextLeft - right;
            return Math.abs(nextTop - top) <= lineTolerance
                && gap >= -1.0f
                && gap <= Math.max(8.0f, Math.max(size, nextSize) * 2.5f);
        }

        private void append(String nextText, float nextRight, EvidenceChar character) {
            text += nextText;
            right = Math.max(right, nextRight);
            if (character != null) {
                chars.add(character);
            }
        }
    }

    private static final class EvidencePage {
        private final float width;
        private final float height;
        private final List<EvidenceSpan> spans = new ArrayList<>();

        private EvidencePage(float width, float height) {
            this.width = width;
            this.height = height;
        }

        private void add(TextPosition position, int color, String font, boolean bold) {
            String text = position.getUnicode();
            if (text == null || text.isEmpty()) {
                return;
            }
            float left = position.getXDirAdj();
            float top = position.getYDirAdj();
            float right = left + position.getWidthDirAdj();
            float bottom = top + position.getHeightDir();
            float size = position.getFontSizeInPt();
            if (!Float.isFinite(left) || !Float.isFinite(top) || !Float.isFinite(right)
                || !Float.isFinite(bottom) || right <= left || bottom <= top) {
                return;
            }
            EvidenceChar character = color != 0 || bold
                ? new EvidenceChar(text, left, top, right, bottom)
                : null;
            EvidenceSpan previous = spans.isEmpty() ? null : spans.get(spans.size() - 1);
            if (previous != null && previous.canAppend(text, left, top, size, font, bold, color)) {
                previous.append(text, right, character);
                return;
            }
            spans.add(new EvidenceSpan(text, left, top, right, bottom, size, font, bold, color, character));
        }
    }

    private static final class EvidenceStripper extends PDFTextStripper {
        private final List<EvidencePage> pages = new ArrayList<>();
        private EvidencePage currentPage;
        private int currentColor;

        private EvidenceStripper() throws IOException {
            setSortByPosition(true);
            setSuppressDuplicateOverlappingText(true);
            addOperator(new SetNonStrokingColorN(this));
            addOperator(new SetNonStrokingColorSpace(this));
            addOperator(new SetNonStrokingDeviceCMYKColor(this));
            addOperator(new SetNonStrokingDeviceGrayColor(this));
            addOperator(new SetNonStrokingDeviceRGBColor(this));
            addOperator(new SetStrokingColorN(this));
            addOperator(new SetStrokingColorSpace(this));
            addOperator(new SetStrokingDeviceCMYKColor(this));
            addOperator(new SetStrokingDeviceGrayColor(this));
            addOperator(new SetStrokingDeviceRGBColor(this));
        }

        @Override
        protected void startPage(PDPage page) throws IOException {
            super.startPage(page);
            PDRectangle box = page.getCropBox();
            currentPage = new EvidencePage(box.getWidth(), box.getHeight());
            pages.add(currentPage);
        }

        @Override
        protected void showGlyph(Matrix textRenderingMatrix, PDFont font, int code, Vector displacement)
            throws IOException {
            currentColor = readColor();
            super.showGlyph(textRenderingMatrix, font, code, displacement);
        }

        @Override
        protected void processTextPosition(TextPosition position) {
            super.processTextPosition(position);
            if (currentPage == null) {
                return;
            }
            PDFont font = position.getFont();
            String fontName = font == null ? "" : String.valueOf(font.getName());
            boolean bold = isBold(font, fontName);
            currentPage.add(position, currentColor, fontName, bold);
        }

        private int readColor() {
            try {
                PDColor value = getGraphicsState().getNonStrokingColor();
                return value == null ? 0 : value.toRGB() & 0xFFFFFF;
            } catch (IOException | RuntimeException ignored) {
                // A malformed color space should not discard otherwise usable text.
                return 0;
            }
        }

        private static boolean isBold(PDFont font, String fontName) {
            String normalized = fontName.toLowerCase(Locale.ROOT);
            if (normalized.contains("bold") || normalized.contains("black")
                || normalized.contains("heavy") || normalized.contains("demi")) {
                return true;
            }
            if (font == null) {
                return false;
            }
            try {
                PDFontDescriptor descriptor = font.getFontDescriptor();
                if (descriptor == null) {
                    return false;
                }
                if (descriptor.isForceBold() || descriptor.getFontWeight() >= 600.0f) {
                    return true;
                }
                // LaTeX and URW bold faces (CMBX10, NimbusRomNo9L-Medi) leave FontWeight at
                // 0, never set ForceBold and never spell "bold" in the name, so the stem
                // width is the only weight they advertise. Their regular counterparts sit
                // near 70-90; the bold cuts start around 110.
                return descriptor.getStemV() >= BOLD_STEM_WIDTH;
            } catch (RuntimeException ignored) {
                return false;
            }
        }
    }

    private static void writeEvidence(Path input, Path output) throws Exception {
        input = input.toAbsolutePath().normalize();
        output = output.toAbsolutePath().normalize();
        if (!Files.isRegularFile(input)) {
            throw new IllegalArgumentException("invalid PDF evidence input");
        }
        Path temporary = output.resolveSibling(output.getFileName() + ".tmp");
        Path parent = output.getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
        try {
            EvidenceStripper stripper;
            try (PDDocument document = Loader.loadPDF(input.toFile())) {
                if (document.getNumberOfPages() > MAX_EVIDENCE_PAGES) {
                    throw new IllegalArgumentException("PDF evidence page limit exceeded");
                }
                stripper = new EvidenceStripper();
                stripper.writeText(document, Writer.nullWriter());
            }
            int spanCount = 0;
            int textChars = 0;
            int charCount = 0;
            for (EvidencePage page : stripper.pages) {
                spanCount += page.spans.size();
                for (EvidenceSpan span : page.spans) {
                    textChars += span.text.length();
                    charCount += span.chars.size();
                }
            }
            if (spanCount > MAX_EVIDENCE_SPANS || charCount > MAX_EVIDENCE_TEXT_CHARS
                || textChars > MAX_EVIDENCE_TEXT_CHARS) {
                throw new IllegalArgumentException("PDF evidence text limit exceeded");
            }
            try (BufferedWriter writer = Files.newBufferedWriter(temporary, StandardCharsets.UTF_8)) {
                writer.write('[');
                for (int pageIndex = 0; pageIndex < stripper.pages.size(); pageIndex += 1) {
                    if (pageIndex > 0) {
                        writer.write(',');
                    }
                    EvidencePage page = stripper.pages.get(pageIndex);
                    writer.write("{\"width\":");
                    writer.write(Float.toString(page.width));
                    writer.write(",\"height\":");
                    writer.write(Float.toString(page.height));
                    writer.write(",\"spans\":[");
                    for (int spanIndex = 0; spanIndex < page.spans.size(); spanIndex += 1) {
                        if (spanIndex > 0) {
                            writer.write(',');
                        }
                        EvidenceSpan span = page.spans.get(spanIndex);
                        writer.write("{\"text\":\"");
                        writer.write(jsonEscape(span.text));
                        writer.write("\",\"bbox\":[");
                        writer.write(Float.toString(span.left));
                        writer.write(',');
                        writer.write(Float.toString(span.top));
                        writer.write(',');
                        writer.write(Float.toString(span.right));
                        writer.write(',');
                        writer.write(Float.toString(span.bottom));
                        writer.write("],\"size\":");
                        writer.write(Float.toString(span.size));
                        writer.write(",\"font\":\"");
                        writer.write(jsonEscape(span.font));
                        writer.write("\",\"color\":");
                        writer.write(Integer.toString(span.color));
                        writer.write(",\"bold\":");
                        writer.write(Boolean.toString(span.bold));
                        if (!span.chars.isEmpty()) {
                            writer.write(",\"chars\":[");
                            for (int charIndex = 0; charIndex < span.chars.size(); charIndex += 1) {
                                if (charIndex > 0) {
                                    writer.write(',');
                                }
                                EvidenceChar character = span.chars.get(charIndex);
                                writer.write("{\"text\":\"");
                                writer.write(jsonEscape(character.text));
                                writer.write("\",\"bbox\":[");
                                writer.write(Float.toString(character.left));
                                writer.write(',');
                                writer.write(Float.toString(character.top));
                                writer.write(',');
                                writer.write(Float.toString(character.right));
                                writer.write(',');
                                writer.write(Float.toString(character.bottom));
                                writer.write("]}");
                            }
                            writer.write(']');
                        }
                        writer.write('}');
                    }
                    writer.write("],\"drawings\":[]}");
                }
                writer.write(']');
            }
            Files.move(temporary, output, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private static String jsonEscape(String value) {
        StringBuilder escaped = new StringBuilder(value.length() + 16);
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            switch (character) {
                case '\\':
                    escaped.append("\\\\");
                    break;
                case '"':
                    escaped.append("\\\"");
                    break;
                case '\b':
                    escaped.append("\\b");
                    break;
                case '\f':
                    escaped.append("\\f");
                    break;
                case '\n':
                    escaped.append("\\n");
                    break;
                case '\r':
                    escaped.append("\\r");
                    break;
                case '\t':
                    escaped.append("\\t");
                    break;
                default:
                    if (character < 0x20) {
                        escaped.append(String.format(Locale.ROOT, "\\u%04x", (int) character));
                    } else {
                        escaped.append(character);
                    }
                    break;
            }
        }
        return escaped.toString();
    }

    private static void renderPages(String[] args) throws Exception {
        Path input = Path.of(args[0]).toAbsolutePath().normalize();
        Path output = Path.of(args[1]).toAbsolutePath().normalize();
        int dpi = Integer.parseInt(args[2]);
        int requestedPages = Integer.parseInt(args[3]);
        if (!Files.isRegularFile(input) || dpi < 36 || dpi > 600 || requestedPages < 1) {
            throw new IllegalArgumentException("invalid PDF render request");
        }
        Files.createDirectories(output);
        try (PDDocument document = Loader.loadPDF(input.toFile())) {
            if (document.getNumberOfPages() < requestedPages) {
                throw new IllegalArgumentException("PDF has fewer pages than requested");
            }
            PDFRenderer renderer = new PDFRenderer(document);
            for (int index = 0; index < requestedPages; index += 1) {
                BufferedImage image = renderer.renderImageWithDPI(index, dpi, ImageType.RGB);
                Path target = output.resolve(String.format("page-%03d.png", index + 1));
                if (!ImageIO.write(image, "png", target.toFile())) {
                    throw new IllegalStateException("PNG writer is unavailable");
                }
            }
        }
    }

    private static final class CropRequest {
        private final int page;
        private final double left;
        private final double top;
        private final double right;
        private final double bottom;
        private final int dpi;
        private final Path output;

        private CropRequest(int page, double left, double top, double right, double bottom, int dpi, Path output) {
            this.page = page;
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
            this.dpi = dpi;
            this.output = output;
        }
    }

    private static void renderCrops(Path input, Path manifest) throws Exception {
        input = input.toAbsolutePath().normalize();
        manifest = manifest.toAbsolutePath().normalize();
        if (!Files.isRegularFile(input) || !Files.isRegularFile(manifest)) {
            throw new IllegalArgumentException("invalid PDF or crop manifest");
        }
        Map<String, List<CropRequest>> requestsByRender = new LinkedHashMap<>();
        try (BufferedReader reader = Files.newBufferedReader(manifest)) {
            String line;
            int lineNumber = 0;
            while ((line = reader.readLine()) != null) {
                lineNumber += 1;
                if (line.isBlank()) {
                    continue;
                }
                String[] fields = line.split("\\t", -1);
                if (fields.length != 7) {
                    throw new IllegalArgumentException("invalid crop manifest line " + lineNumber);
                }
                int page = Integer.parseInt(fields[0]);
                double left = Double.parseDouble(fields[1]);
                double top = Double.parseDouble(fields[2]);
                double right = Double.parseDouble(fields[3]);
                double bottom = Double.parseDouble(fields[4]);
                int dpi = Integer.parseInt(fields[5]);
                Path output = Path.of(fields[6]).toAbsolutePath().normalize();
                if (page < 1 || dpi < 36 || dpi > 600
                    || !Double.isFinite(left) || !Double.isFinite(top)
                    || !Double.isFinite(right) || !Double.isFinite(bottom)
                    || left < 0.0 || top < 0.0 || right > 1.0 || bottom > 1.0
                    || right <= left || bottom <= top) {
                    throw new IllegalArgumentException("invalid crop manifest line " + lineNumber);
                }
                CropRequest request = new CropRequest(page, left, top, right, bottom, dpi, output);
                String key = page + "@" + dpi;
                requestsByRender.computeIfAbsent(key, ignored -> new ArrayList<>()).add(request);
            }
        }
        if (requestsByRender.isEmpty()) {
            return;
        }
        try (PDDocument document = Loader.loadPDF(input.toFile())) {
            PDFRenderer renderer = new PDFRenderer(document);
            for (List<CropRequest> requests : requestsByRender.values()) {
                CropRequest first = requests.get(0);
                if (first.page > document.getNumberOfPages()) {
                    throw new IllegalArgumentException("crop page is outside the PDF");
                }
                BufferedImage pageImage = renderer.renderImageWithDPI(first.page - 1, first.dpi, ImageType.RGB);
                for (CropRequest request : requests) {
                    int left = clampPixel((int) Math.round(request.left * pageImage.getWidth()), pageImage.getWidth());
                    int top = clampPixel((int) Math.round(request.top * pageImage.getHeight()), pageImage.getHeight());
                    int right = clampPixel((int) Math.round(request.right * pageImage.getWidth()), pageImage.getWidth());
                    int bottom = clampPixel((int) Math.round(request.bottom * pageImage.getHeight()), pageImage.getHeight());
                    if (right <= left || bottom <= top) {
                        throw new IllegalArgumentException("crop region is empty");
                    }
                    Files.createDirectories(request.output.getParent());
                    BufferedImage crop = pageImage.getSubimage(left, top, right - left, bottom - top);
                    if (!ImageIO.write(crop, "png", request.output.toFile())) {
                        throw new IOException("PNG writer is unavailable");
                    }
                }
            }
        }
    }

    private static int clampPixel(int value, int limit) {
        return Math.max(0, Math.min(limit, value));
    }
}
