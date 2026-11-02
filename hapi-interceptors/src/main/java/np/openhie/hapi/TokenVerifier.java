package np.openhie.hapi;

import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.jwk.source.JWKSourceBuilder;
import com.nimbusds.jose.proc.DefaultJOSEObjectTypeVerifier;
import com.nimbusds.jose.proc.JWSVerificationKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.proc.DefaultJWTClaimsVerifier;
import com.nimbusds.jwt.proc.DefaultJWTProcessor;
import java.net.URI;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Verifies the client's Keycloak access token on every request: RS256 signature against the
 * realm JWKS (cached, refreshed on key rotation), issuer, expiry. DPoP proofs are checked once,
 * by OpenHIM at the edge; inside the network the signed token is what names the caller.
 */
final class TokenVerifier {
  record Caller(String clientId, List<String> scopes) {}

  private static final Pattern HEADER = Pattern.compile("^(?:DPoP|Bearer) ([\\w-]+\\.[\\w-]+\\.[\\w-]+)$");
  private final DefaultJWTProcessor<SecurityContext> processor = new DefaultJWTProcessor<>();

  TokenVerifier(String issuer, String jwksUri) {
    try {
      JWKSource<SecurityContext> keys = JWKSourceBuilder.create(URI.create(jwksUri).toURL()).retrying(true).build();
      processor.setJWSTypeVerifier(
          new DefaultJOSEObjectTypeVerifier<>(JOSEObjectType.JWT, new JOSEObjectType("at+jwt"), null));
      processor.setJWSKeySelector(new JWSVerificationKeySelector<>(JWSAlgorithm.RS256, keys));
      processor.setJWTClaimsSetVerifier(
          new DefaultJWTClaimsVerifier<>(new JWTClaimsSet.Builder().issuer(issuer).build(), Set.of("exp")));
    } catch (Exception e) {
      throw new IllegalStateException("Invalid NP_AUTH_JWKS_URI: " + jwksUri, e);
    }
  }

  /** The caller, or null when the header is missing or the token does not verify. */
  Caller verify(String authorization) {
    if (authorization == null) return null;
    Matcher m = HEADER.matcher(authorization.trim());
    if (!m.matches()) return null;
    try {
      JWTClaimsSet claims = processor.process(m.group(1), null);
      String client = firstNonNull(claims.getStringClaim("azp"), claims.getStringClaim("client_id"), claims.getSubject());
      if (client == null) return null;
      String scope = claims.getStringClaim("scope");
      List<String> scopes = scope == null ? List.of() : Arrays.stream(scope.split(" ")).filter(s -> !s.isBlank()).toList();
      return new Caller(client, scopes);
    } catch (Exception e) {
      return null;
    }
  }

  private static String firstNonNull(String... values) {
    for (String v : values) if (v != null && !v.isBlank()) return v;
    return null;
  }
}
