// Synthetic test documents, no personal investment data.
#import <AppKit/AppKit.h>
#import <PDFKit/PDFKit.h>
int main(int argc,const char *argv[]){@autoreleasepool{
 NSString *folder=[NSString stringWithUTF8String:argv[1]];
 NSBitmapImageRep *rep=[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:1200 pixelsHigh:700 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
 [NSGraphicsContext saveGraphicsState];[NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:rep]];
 [[NSColor whiteColor] setFill];NSRectFill(NSMakeRect(0,0,1200,700));
 NSArray *lines=@[@"SYNTHETIC OCR TEST - NOT INVESTMENT DATA",@"测试资料：需求改善尚待验证",@"收入 123.45 亿元，同比增长 12.8%",@"2026-01-02  Code 600001",@"图片中的观点不代表用户认同"];
 for(NSUInteger i=0;i<lines.count;i++)[lines[i] drawAtPoint:NSMakePoint(45,590-i*110) withAttributes:@{NSFontAttributeName:[NSFont systemFontOfSize:i==0?30:42],NSForegroundColorAttributeName:NSColor.blackColor}];
 [NSGraphicsContext restoreGraphicsState];
 NSData *png=[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
 [png writeToFile:[folder stringByAppendingPathComponent:@"synthetic.png"] atomically:YES];
 [[rep representationUsingType:NSBitmapImageFileTypeJPEG properties:@{NSImageCompressionFactor:@0.9}] writeToFile:[folder stringByAppendingPathComponent:@"synthetic.jpg"] atomically:YES];
 NSImage *image=[[NSImage alloc] initWithData:png];
 PDFDocument *scanned=[PDFDocument new];[scanned insertPage:[[PDFPage alloc] initWithImage:image] atIndex:0];[scanned insertPage:[PDFPage new] atIndex:1];[scanned writeToFile:[folder stringByAppendingPathComponent:@"scanned.pdf"]];
 PDFDocument *longScan=[PDFDocument new];for(NSUInteger n=0;n<11;n++)[longScan insertPage:[[PDFPage alloc] initWithImage:image] atIndex:n];[longScan writeToFile:[folder stringByAppendingPathComponent:@"long-scan.pdf"]];
 return 0;
}}
