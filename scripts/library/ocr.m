// Offline Apple Vision OCR. JSON lines preserve completed pages on timeout.
#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <ImageIO/ImageIO.h>
#import <PDFKit/PDFKit.h>
#import <AppKit/AppKit.h>
static void emit(NSDictionary *value) {
 NSData *data=[NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
 if(data){fwrite(data.bytes,1,data.length,stdout);fputc('\n',stdout);fflush(stdout);}
}
static BOOL recognize(CGImageRef image, NSInteger page) {
 VNRecognizeTextRequest *request=[VNRecognizeTextRequest new];
 request.recognitionLevel=VNRequestTextRecognitionLevelAccurate;
 request.usesLanguageCorrection=NO;
 NSArray *supported=[request supportedRecognitionLanguagesAndReturnError:nil];
 NSMutableArray *languages=[NSMutableArray new];
 for(NSString *language in @[@"zh-Hans",@"zh-Hant",@"en-US"])if([supported containsObject:language])[languages addObject:language];
 request.recognitionLanguages=languages;
 VNImageRequestHandler *handler=[[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
 if(![handler performRequests:@[request] error:nil])return NO;
 NSMutableArray *lines=[NSMutableArray new];BOOL truncated=request.results.count>2000;
 for(VNRecognizedTextObservation *observation in request.results){
  VNRecognizedText *candidate=[observation topCandidates:1].firstObject;
  if(!candidate)continue; CGRect b=observation.boundingBox;
  NSString *text=candidate.string;if(text.length>2000){truncated=YES;text=[text substringToIndex:2000];}
  [lines addObject:@{@"text":text,@"confidence":@(candidate.confidence),@"box":@[@(b.origin.x),@(b.origin.y),@(b.size.width),@(b.size.height)]}];
  if(lines.count>=2000)break;
 }
 emit(@{@"page":@(page),@"lines":lines,@"truncated":@(truncated)});return YES;
}
int main(int argc,const char *argv[]){@autoreleasepool{
 if(argc!=4)return 1;
 NSURL *url=[NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
 if(strcmp(argv[2],"pdf")==0){
  PDFDocument *document=[[PDFDocument alloc] initWithURL:url];
  if(!document||document.isLocked){emit(@{@"error":@"PDF无法读取"});return 1;}
  NSArray *pages=[[NSString stringWithUTF8String:argv[3]] componentsSeparatedByString:@","];
  for(NSUInteger i=0;i<MIN(pages.count,10);i++){@autoreleasepool{
   NSInteger number=[pages[i] integerValue];BOOL success=NO;
   if(number>0&&number<=document.pageCount){
    PDFPage *page=[document pageAtIndex:number-1];NSRect bounds=[page boundsForBox:kPDFDisplayBoxMediaBox];
    if(isfinite(bounds.size.width)&&isfinite(bounds.size.height)&&bounds.size.width>0&&bounds.size.height>0){
     CGFloat scale=3000/MAX(bounds.size.width,bounds.size.height);
     NSImage *thumbnail=[page thumbnailOfSize:NSMakeSize(MAX(1,bounds.size.width*scale),MAX(1,bounds.size.height*scale)) forBox:kPDFDisplayBoxMediaBox];
     CGImageRef image=[thumbnail CGImageForProposedRect:NULL context:nil hints:nil];
     if(image)success=recognize(image,number);
    }
   }
   if(!success)emit(@{@"page":@(number),@"error":@"页面无法识别"});
  }}
 }else{
  CGImageSourceRef source=CGImageSourceCreateWithURL((__bridge CFURLRef)url,(__bridge CFDictionaryRef)@{(__bridge NSString*)kCGImageSourceShouldCache:@NO});
  NSDictionary *options=@{(__bridge NSString*)kCGImageSourceCreateThumbnailFromImageAlways:@YES,(__bridge NSString*)kCGImageSourceCreateThumbnailWithTransform:@YES,(__bridge NSString*)kCGImageSourceThumbnailMaxPixelSize:@4000,(__bridge NSString*)kCGImageSourceShouldCacheImmediately:@YES};
  CGImageRef image=source?CGImageSourceCreateThumbnailAtIndex(source,0,(__bridge CFDictionaryRef)options):NULL;
  BOOL success=image&&recognize(image,1);if(image)CGImageRelease(image);if(source)CFRelease(source);
  if(!success){emit(@{@"error":@"图片无法识别"});return 1;}
 }
 return 0;
}}
